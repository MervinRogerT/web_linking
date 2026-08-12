const path = require('path');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 60 * 1000;
const DESTINATION_URL = 'https://www.whitepixeltechnologies.in/';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://web-linking.onrender.com';

// Only the newest QR token is valid at any time.
let activeQrToken = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * In-memory session store.
 * sessionId -> {
 *   status: 'pending' | 'linked',
 *   expiresAt: number,
 *   webSocketId: string,   // which browser tab is waiting on this code
 *   linkUrl: string,
 *   phoneInfo: { linkedAt, userAgent } | null
 * }
 */
const sessions = new Map();

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

async function createSession(webSocketId, baseUrl) {
  const sessionId = crypto.randomUUID();
  activeQrToken = sessionId;
  const expiresAt = Date.now() + SESSION_TTL_MS;

  // IMPORTANT: the QR must contain the active session ID.
  // This preserves the existing Link Device flow.
  const linkUrl = `${PUBLIC_BASE_URL}/link/${sessionId}`;

  const qrDataUrl = await QRCode.toDataURL(linkUrl, {
    margin: 1,
    width: 320,
    color: { dark: '#0B1B2B', light: '#EDE7D9' }
  });
  sessions.set(sessionId, {
    status: 'pending',
    expiresAt,
    webSocketId,
    linkUrl,
    phoneInfo: null
  });
  return { sessionId, qrDataUrl, expiresAt };
}

// ---------------------------------------------------------------
// Realtime side: the web bridge console
// ---------------------------------------------------------------
io.on('connection', (socket) => {
  let currentSessionId = null;
  let rotateTimer = null;

  async function issueNewSession(baseUrl) {
    if (currentSessionId) sessions.delete(currentSessionId);
    clearTimeout(rotateTimer);

    const { sessionId, qrDataUrl, expiresAt } = await createSession(socket.id, baseUrl);
    currentSessionId = sessionId;
    socket.emit('session', { sessionId, qrDataUrl, expiresAt });

    rotateTimer = setTimeout(() => {
      const s = sessions.get(sessionId);
      // Only auto-regenerate if nobody linked it in time — a linked
      // session is left alone so the web side can show "connected".
      if (s && s.status === 'pending') {
        sessions.delete(sessionId);
        issueNewSession(baseUrl);
      }
    }, SESSION_TTL_MS); // generate a new QR every 60 seconds
  }

  socket.on('start', ({ baseUrl }) => {
    issueNewSession(baseUrl || process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`);
  });

  socket.on('unlink', () => {
    if (currentSessionId) sessions.delete(currentSessionId);
    currentSessionId = null;
  });

  socket.on('disconnect', () => {
    clearTimeout(rotateTimer);
    if (currentSessionId) sessions.delete(currentSessionId);
  });
});

// ---------------------------------------------------------------
// Phone side: opened by scanning the QR (any camera app works,
// since the QR just encodes a normal URL — no app install needed)
// ---------------------------------------------------------------
app.get('/go', (req, res) => {
  return res.send(phonePage('confirm', null, true));
});

app.post('/go/confirm', (req, res) => {
  // Stateless public QR flow: no local session lookup is required.
  res.json({ ok: true });
});

app.get('/link/:sessionId', (req, res) => {
  if (req.params.sessionId !== activeQrToken) {
    return res.status(410).send(shell(`
      <div class="eyebrow">QR Code</div>
      <div class="badge">⌛</div>
      <h1>QR code expired</h1>
      <p>Please scan the latest QR code.</p>
    `));
  }
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).send(phonePage('invalid'));
  }
  if (session.status === 'linked') {
    return res.send(phonePage('used'));
  }
  if (Date.now() > session.expiresAt) {
    return res.send(phonePage('expired'));
  }
  return res.send(phonePage('confirm', req.params.sessionId));
});

app.post('/link/:sessionId/confirm', (req, res) => {
  if (activeQrToken === req.params.sessionId) activeQrToken = null;

  const session = sessions.get(req.params.sessionId);

  if (!session) return res.status(404).json({ ok: false, error: 'not_found' });
  if (Date.now() > session.expiresAt) return res.status(410).json({ ok: false, error: 'expired' });
  if (session.status !== 'pending') return res.status(409).json({ ok: false, error: 'already_used' });

  session.status = 'linked';
  session.phoneInfo = {
    linkedAt: Date.now(),
    userAgent: req.get('user-agent') || 'unknown device'
  };

  // Push to the exact browser tab that owns this session — this is
  // what makes both sides go "active" at the same moment.
  io.to(session.webSocketId).emit('linked', {
    sessionId: req.params.sessionId,
    linkedAt: session.phoneInfo.linkedAt
  });

  res.json({ ok: true });
});

function phonePage(state, sessionId, stateless = false) {
  const shell = (inner) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sealine — Handset</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(120% 140% at 50% -10%,#123447 0%,#0B1B2B 45%,#071320 100%);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#EDE7D9;padding:24px;}
  .card{max-width:360px;width:100%;text-align:center;background:rgba(237,231,217,0.05);
    border:1px solid rgba(237,231,217,0.14);border-radius:18px;padding:34px 26px;}
  .badge{width:60px;height:60px;margin:0 auto 18px;border-radius:50%;display:flex;
    align-items:center;justify-content:center;font-size:26px;}
  h1{font-size:19px;margin:0 0 8px;font-weight:600;}
  p{font-size:13.5px;color:rgba(237,231,217,0.65);line-height:1.5;margin:0 0 22px;}
  button{width:100%;padding:13px;border-radius:10px;border:1px solid #C9A227;background:#C9A227;
    color:#071320;font-weight:600;font-size:14px;cursor:pointer;}
  button:disabled{opacity:0.5;}
  .eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#E3B23C;margin-bottom:10px;}
</style></head><body><div class="card">${inner}</div></body></html>`;

  if (state === 'confirm') {
    return shell(`
      <div class="eyebrow">Handset</div>
      <div class="badge" style="border:1px solid #C9A227;color:#E3B23C;">&#128274;</div>
      <h1>Link this handset</h1>
      <p>Tap the button below to continue.</p>

      <button id="confirmBtn" onclick="confirmLink()">Link Device</button>

      <script>
        async function confirmLink() {
          const btn = document.getElementById('confirmBtn');
          btn.disabled = true;
          btn.textContent = 'Your account is linking...';

          try {
            const res = await fetch(stateless ? '/go/confirm' : '/link/${sessionId}/confirm', {
              method: 'POST'
            });
            const data = await res.json();

            if (data.ok) {
              setTimeout(() => {
                window.location.replace('https://www.whitepixeltechnologies.in/');
              }, 3000);
            } else {
              btn.disabled = false;
              btn.textContent = 'Link Device';
              alert('Unable to link. Please try again.');
            }
          } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Link Device';
            alert('Connection error. Please try again.');
          }
        }
      </script>
    `);
  }

  if (state === 'expired') {
    return shell(`
      <div class="eyebrow">Handset</div>
      <div class="badge" style="border:1px solid #C1443C;color:#C1443C;">&#33;</div>
      <h1>This code has expired</h1>
      <p>Sealine codes refresh every 60 seconds. Go back to the bridge console — it will already be showing a new one — and scan again.</p>
    `);
  }

  if (state === 'used') {
    return shell(`
      <div class="eyebrow">Handset</div>
      <div class="badge" style="border:1px solid #C1443C;color:#C1443C;">&#33;</div>
      <h1>This code was already used</h1>
      <p>Each code links one handset. If you need to link another device, generate a new code from the bridge console.</p>
    `);
  }

  return shell(`
    <div class="eyebrow">Handset</div>
    <div class="badge" style="border:1px solid #C1443C;color:#C1443C;">&#33;</div>
    <h1>Code not recognized</h1>
    <p>This link doesn't match an active Sealine session. Scan the current code shown on the bridge console.</p>
  `);
}

server.listen(PORT, '0.0.0.0', () => {
  const lan = getLocalIP();
  console.log('Sealine server running:');
  console.log(`  Local:    http://localhost:${PORT}`);
  if (lan) console.log(`  Network:  http://${lan}:${PORT}   <- open this on your phone if it's on the same Wi-Fi`);
  else console.log('  Network:  (no LAN IP detected)');
});
