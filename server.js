const path = require("path");
const crypto = require("crypto");
const os = require("os");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 60 * 1000;

const DESTINATION_URL = "https://www.whitepixeltechnologies.in/";
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://web-linking.onrender.com";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sessions = new Map();

function getLocalIP() {
  const nets = os.networkInterfaces();

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }

  return null;
}

async function createSession(webSocketId) {
  const sessionId = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_MS;

  const linkUrl = `${PUBLIC_BASE_URL}/link/${sessionId}`;

  const qrDataUrl = await QRCode.toDataURL(linkUrl, {
    margin: 1,
    width: 320,
    color: {
      dark: "#0B1B2B",
      light: "#EDE7D9"
    }
  });

  sessions.set(sessionId, {
    status: "pending",
    expiresAt,
    webSocketId,
    linkUrl
  });

  return {
    sessionId,
    qrDataUrl,
    expiresAt
  };
}

/* =========================
   DESKTOP / BRIDGE
========================= */

io.on("connection", (socket) => {
  let currentSessionId = null;
  let rotateTimer = null;

  async function issueNewSession() {
    if (currentSessionId) {
      sessions.delete(currentSessionId);
    }

    clearTimeout(rotateTimer);

    const {
      sessionId,
      qrDataUrl,
      expiresAt
    } = await createSession(socket.id);

    currentSessionId = sessionId;

    socket.emit("session", {
      sessionId,
      qrDataUrl,
      expiresAt
    });

    rotateTimer = setTimeout(async () => {
      sessions.delete(sessionId);

      if (currentSessionId === sessionId) {
        currentSessionId = null;
        await issueNewSession();
      }
    }, SESSION_TTL_MS);
  }

  socket.on("start", async () => {
    await issueNewSession();
  });

  socket.on("unlink", () => {
    if (currentSessionId) {
      sessions.delete(currentSessionId);
    }

    currentSessionId = null;
    clearTimeout(rotateTimer);
  });

  socket.on("disconnect", () => {
    clearTimeout(rotateTimer);

    if (currentSessionId) {
      sessions.delete(currentSessionId);
    }
  });
});

/* =========================
   MOBILE QR PAGE
========================= */

app.get("/link/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(410).send(phonePage("expired"));
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(req.params.sessionId);

    return res.status(410).send(phonePage("expired"));
  }

  if (session.status === "used") {
    return res.send(phonePage("used"));
  }

  return res.send(phonePage("confirm", req.params.sessionId));
});

/* =========================
   LINK BUTTON
========================= */

app.post("/link/:sessionId/confirm", (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(410).json({
      ok: false,
      error: "expired"
    });
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(req.params.sessionId);

    return res.status(410).json({
      ok: false,
      error: "expired"
    });
  }

  if (session.status !== "pending") {
    return res.status(409).json({
      ok: false,
      error: "already_used"
    });
  }

  session.status = "used";

  io.to(session.webSocketId).emit("linked", {
    sessionId: req.params.sessionId,
    linkedAt: Date.now()
  });

  return res.json({
    ok: true
  });
});

/* =========================
   MOBILE PAGE
========================= */

function phonePage(state, sessionId) {
  const shell = (content) => `
<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width, initial-scale=1.0"
>

<title>Sealine</title>

<style>

body {
  margin: 0;
  min-height: 100vh;

  display: flex;
  align-items: center;
  justify-content: center;

  background:
  radial-gradient(
    120% 140% at 50% -10%,
    #123447 0%,
    #0B1B2B 45%,
    #071320 100%
  );

  font-family:
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  sans-serif;

  color: #EDE7D9;

  padding: 24px;
}

.card {
  max-width: 360px;
  width: 100%;

  text-align: center;

  background: rgba(237,231,217,0.05);

  border:
  1px solid rgba(237,231,217,0.14);

  border-radius: 18px;

  padding: 34px 26px;
}

.eyebrow {
  font-size: 11px;

  letter-spacing: .18em;

  text-transform: uppercase;

  color: #E3B23C;

  margin-bottom: 10px;
}

.badge {
  width: 60px;
  height: 60px;

  margin: 0 auto 18px;

  border-radius: 50%;

  display: flex;

  align-items: center;
  justify-content: center;

  font-size: 26px;
}

h1 {
  font-size: 19px;

  margin:
  0 0 8px;

  font-weight: 600;
}

p {
  font-size: 13.5px;

  color:
  rgba(237,231,217,0.65);

  line-height: 1.5;

  margin:
  0 0 22px;
}

button {
  width: 100%;

  padding: 13px;

  border-radius: 10px;

  border:
  1px solid #C9A227;

  background: #C9A227;

  color: #071320;

  font-weight: 600;

  font-size: 14px;
}

button:disabled {
  opacity: 0.5;
}

</style>

</head>

<body>

<div class="card">

${content}

</div>

</body>

</html>
`;

  /* =====================
     CONFIRM PAGE
  ===================== */

  if (state === "confirm") {
    return shell(`

<div class="eyebrow">
  Handset
</div>

<div
class="badge"
style="
border:1px solid #C9A227;
color:#E3B23C;
"
>
🔗
</div>

<h1>
Continue
</h1>

<p>
Tap the button below to continue.
</p>

<button
id="confirmBtn"
onclick="continueToWebsite()"
>
Link Device
</button>

<script>

async function continueToWebsite() {

  const btn =
  document.getElementById("confirmBtn");

  btn.disabled = true;

  btn.textContent =
  "Your account is linking...";

  try {

    const response =
    await fetch(
      "/link/${sessionId}/confirm",
      {
        method: "POST"
      }
    );

    const data =
    await response.json();

    if (!data.ok) {

      btn.disabled = false;

      btn.textContent =
      "Link Device";

      alert(
        "QR code expired. Please scan the latest QR code."
      );

      return;
    }

    setTimeout(() => {

      window.location.replace(
        "${DESTINATION_URL}"
      );

    }, 3000);

  } catch (error) {

    btn.disabled = false;

    btn.textContent =
    "Link Device";

    alert(
      "Connection error. Please try again."
    );

  }

}

</script>

`);
  }

  /* =====================
     EXPIRED
  ===================== */

  if (state === "expired") {
    return shell(`

<div class="eyebrow">
  Handset
</div>

<div
class="badge"
style="
border:1px solid #C1443C;
color:#C1443C;
"
>
!
</div>

<h1>
QR Code Expired
</h1>

<p>
This QR code is no longer active.
Please scan the latest QR code.
</p>

`);
  }

  /* =====================
     USED
  ===================== */

  if (state === "used") {
    return shell(`

<div class="eyebrow">
  Handset
</div>

<div
class="badge"
style="
border:1px solid #C1443C;
color:#C1443C;
"
>
!
</div>

<h1>
QR Code Already Used
</h1>

<p>
Please scan the latest QR code.
</p>

`);
  }
}

/* =========================
   SERVER
========================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    const lan = getLocalIP();

    console.log(
      "Sealine server running:"
    );

    console.log(
      `Local: http://localhost:${PORT}`
    );

    if (lan) {

      console.log(
        `Network: http://${lan}:${PORT}`
      );

    }

  }
);