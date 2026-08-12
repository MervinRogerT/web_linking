# Sealine Link Server

A real Node.js backend (Express + Socket.IO) that:

- generates a fresh linking session and QR code
- auto-rotates the QR every 60 seconds if it isn't scanned
- lets your phone confirm the link by opening a normal URL (any camera app can scan it — no separate app needed)
- pushes a `linked` event over a websocket the instant the phone confirms, so the web page and phone go "connected" at the same moment

## Run it

```bash
npm install
npm start
```

You'll see:

```
Sealine server running:
  Local:    http://localhost:3000
  Network:  http://192.168.x.x:3000   <- open this on your phone if it's on the same Wi-Fi
```

Open the **Local** URL in your computer's browser — that's the bridge console, it'll show a QR immediately.

## Deploying it so any phone, on any network, can scan

The server already builds the QR from whatever address you load the page from — so once it's running on a public URL, no code changes are needed. Recommended: **Render** (free tier, works with Socket.IO/websockets out of the box).

1. **Push this project to GitHub.** Create a new repo (github.com → New repository), then from inside the `sealine-link` folder:
   ```bash
   git init
   git add .
   git commit -m "Sealine link server"
   git branch -M main
   git remote add origin https://github.com/<your-username>/sealine-link.git
   git push -u origin main
   ```

2. **Create a free Render account** at [render.com](https://render.com) and sign in with GitHub.

3. **New + → Web Service**, pick the `sealine-link` repo. Render will detect `render.yaml` automatically and fill in:
   - Build command: `npm install`
   - Start command: `npm start`
   (If it doesn't auto-detect, enter those two manually — no other settings needed.)

4. Click **Create Web Service**. First deploy takes a couple of minutes. You'll get a URL like:
   ```
   https://sealine-link.onrender.com
   ```

5. Open that URL (not localhost) in your browser. The QR it shows now encodes `https://sealine-link.onrender.com/link/<id>` — any phone, on any network, can scan it and reach it directly.

**Note on the free tier:** Render spins the service down after ~15 minutes of no traffic. The next request wakes it back up but takes 20–30s — fine for testing, but if you need it always-instant, upgrade the plan or ping it periodically.

**Alternative:** Railway (railway.app) works the same way — connect the GitHub repo, it reads the `Procfile`, and gives you a public `*.up.railway.app` URL. Fly.io is another solid free-tier option if you'd rather deploy via CLI instead of GitHub.

## Quick local testing (same Wi-Fi only)

If you just want to sanity-check the app on your own network before deploying, open the **Network** URL the server prints (e.g. `http://192.168.1.42:3000`) instead of `localhost` — your phone can reach that if it's on the same Wi-Fi. This won't work across different networks, which is why deploying is the real fix.

## How the linking actually works

1. Browser opens `/`, connects over Socket.IO, and asks the server for a session (`start` event).
2. Server creates a session ID, builds a link `https://<host>/link/<sessionId>`, encodes it as a QR, and starts a 60-second timer.
3. If no phone confirms within 60s, the server discards that session and issues a new one automatically — the browser never has to ask again.
4. Scanning the QR with any phone camera opens `/link/:sessionId` in the phone's browser. The server checks the session exists, isn't expired, and isn't already used, then shows a **Link device** button.
5. Tapping it sends `POST /link/:sessionId/confirm`. The server marks the session linked and emits a `linked` event to the exact browser tab that owns it.
6. Both sides update immediately: the phone shows "Connected to Sealine", the bridge console shows "Connected" — no polling delay, it's a direct websocket push.

There's no standalone login on the web side — without a linked phone it only ever shows the QR/waiting state.

## Files

- `server.js` — Express + Socket.IO backend, session store, QR generation, phone confirmation routes
- `public/index.html` — the bridge console (web) page
- `package.json` — dependencies (`express`, `socket.io`, `qrcode`)

## Notes on this being a demo-grade server

Sessions live in memory (a `Map`), so they reset if the server restarts, and this isn't set up for multiple concurrent server instances (no shared session store like Redis). For anything beyond local testing, you'd also want HTTPS, and to sign/authenticate the confirm request rather than trusting any phone that opens the link.


## QR redirect behavior

After a QR scan, the handset automatically shows `Your account is linking…`, links the active session, waits briefly, and redirects to `https://www.whitepixeltechnologies.in/`.

### QR rotation
- The QR contains the active session URL.
- A new session/QR is generated every 60 seconds.
- The mobile Link Device flow is unchanged.
- After successful linking, the "Your account is linking..." message remains for 3 seconds before redirecting.

### Public QR behavior
QR codes use `/go?v=<unique-value>` so they work across local and public deployments without relying on an in-memory session on the QR generator. The displayed QR can be regenerated every 60 seconds while preserving the same mobile flow.

### QR expiration
Only the newest QR token is accepted. When a new QR is generated or the 60-second token expires, the previous QR is rejected with an "QR code expired" message.
