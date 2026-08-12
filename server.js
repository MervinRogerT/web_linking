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

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://web-linking.onrender.com";

const DESTINATION_URL =
  "https://www.whitepixeltechnologies.in/";

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/*
==================================================
SESSION STORAGE
==================================================
*/

const sessions = new Map();

/*
==================================================
LOCAL IP
==================================================
*/

function getLocalIP() {

  const networks = os.networkInterfaces();

  for (const name of Object.keys(networks)) {

    for (const network of networks[name]) {

      if (
        network.family === "IPv4" &&
        !network.internal
      ) {
        return network.address;
      }

    }
  }

  return null;
}

/*
==================================================
CREATE QR SESSION
==================================================
*/

async function createSession(socketId) {

  const sessionId =
    crypto.randomUUID();

  const expiresAt =
    Date.now() + SESSION_TTL_MS;

  /*
  The QR contains the actual session ID.
  */

  const linkUrl =
    `${PUBLIC_BASE_URL}/link/${sessionId}`;

  const qrDataUrl =
    await QRCode.toDataURL(
      linkUrl,
      {
        margin: 1,
        width: 320,

        color: {
          dark: "#0B1B2B",
          light: "#EDE7D9"
        }
      }
    );

  sessions.set(
    sessionId,
    {
      socketId: socketId,

      createdAt:
        Date.now(),

      expiresAt:
        expiresAt,

      status:
        "pending"
    }
  );

  return {
    sessionId,
    qrDataUrl,
    expiresAt
  };
}

/*
==================================================
DESKTOP QR CONSOLE
==================================================
*/

io.on(
  "connection",
  (socket) => {

    let currentSessionId =
      null;

    let rotationTimer =
      null;

    /*
    ----------------------------------------------
    GENERATE NEW QR
    ----------------------------------------------
    */

    async function generateNewQR() {

      /*
      Remove previous QR.
      */

      if (currentSessionId) {

        sessions.delete(
          currentSessionId
        );

        currentSessionId =
          null;
      }

      /*
      Stop previous timer.
      */

      if (rotationTimer) {

        clearTimeout(
          rotationTimer
        );

        rotationTimer =
          null;
      }

      /*
      Create new session.
      */

      const result =
        await createSession(
          socket.id
        );

      currentSessionId =
        result.sessionId;

      /*
      Send QR to browser.
      */

      socket.emit(
        "session",
        {
          sessionId:
            result.sessionId,

          qrDataUrl:
            result.qrDataUrl,

          expiresAt:
            result.expiresAt
        }
      );

      /*
      --------------------------------------------
      AUTOMATIC 60 SECOND ROTATION
      --------------------------------------------
      */

      rotationTimer =
        setTimeout(
          async () => {

            /*
            Delete old QR.
            */

            sessions.delete(
              result.sessionId
            );

            /*
            Generate new QR.
            */

            await generateNewQR();

          },
          SESSION_TTL_MS
        );
    }

    /*
    ----------------------------------------------
    START
    ----------------------------------------------
    */

    socket.on(
      "start",
      async () => {

        try {

          await generateNewQR();

        } catch (error) {

          console.error(
            "QR generation error:",
            error
          );

        }

      }
    );

    /*
    ----------------------------------------------
    MANUAL NEW QR
    ----------------------------------------------
    */

    socket.on(
      "newQR",
      async () => {

        try {

          await generateNewQR();

        } catch (error) {

          console.error(
            "New QR error:",
            error
          );

        }

      }
    );

    /*
    ----------------------------------------------
    DISCONNECT
    ----------------------------------------------
    */

    socket.on(
      "disconnect",
      () => {

        if (rotationTimer) {

          clearTimeout(
            rotationTimer
          );

        }

        if (currentSessionId) {

          sessions.delete(
            currentSessionId
          );

        }

      }
    );

  }
);

/*
==================================================
MOBILE QR PAGE
==================================================
*/

app.get(
  "/link/:sessionId",
  (req, res) => {

    const sessionId =
      req.params.sessionId;

    const session =
      sessions.get(
        sessionId
      );

    /*
    QR does not exist.
    */

    if (!session) {

      return res
        .status(410)
        .send(
          mobilePage(
            "expired"
          )
        );

    }

    /*
    QR expired.
    */

    if (
      Date.now() >=
      session.expiresAt
    ) {

      sessions.delete(
        sessionId
      );

      return res
        .status(410)
        .send(
          mobilePage(
            "expired"
          )
        );

    }

    /*
    QR already used.
    */

    if (
      session.status ===
      "used"
    ) {

      return res.send(
        mobilePage(
          "used"
        )
      );

    }

    /*
    Valid QR.
    */

    return res.send(
      mobilePage(
        "confirm",
        sessionId
      )
    );

  }
);

/*
==================================================
LINK DEVICE BUTTON
==================================================
*/

app.post(
  "/link/:sessionId/confirm",
  (req, res) => {

    const sessionId =
      req.params.sessionId;

    const session =
      sessions.get(
        sessionId
      );

    /*
    QR not found.
    */

    if (!session) {

      return res
        .status(410)
        .json({
          ok: false,
          error: "expired"
        });

    }

    /*
    QR expired.
    */

    if (
      Date.now() >=
      session.expiresAt
    ) {

      sessions.delete(
        sessionId
      );

      return res
        .status(410)
        .json({
          ok: false,
          error: "expired"
        });

    }

    /*
    Already used.
    */

    if (
      session.status !==
      "pending"
    ) {

      return res
        .status(409)
        .json({
          ok: false,
          error: "already_used"
        });

    }

    /*
    Mark this QR as used.
    */

    session.status =
      "used";

    /*
    Tell desktop console.
    */

    io.to(
      session.socketId
    ).emit(
      "linked",
      {
        sessionId:
          sessionId,

        time:
          Date.now()
      }
    );

    /*
    Tell mobile everything is okay.
    */

    return res.json({
      ok: true
    });

  }
);

/*
==================================================
MOBILE PAGE
==================================================
*/

function mobilePage(
  state,
  sessionId
) {

  const html = `

<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width, initial-scale=1.0"
>

<title>Sealine</title>

<style>

* {
  box-sizing: border-box;
}

body {

  margin: 0;

  min-height: 100vh;

  display: flex;

  align-items: center;

  justify-content: center;

  padding: 20px;

  font-family:
    Arial,
    sans-serif;

  background:
    radial-gradient(
      circle at top,
      #123447,
      #071320 70%
    );

  color: #EDE7D9;
}

.card {

  width: 100%;

  max-width: 370px;

  padding: 32px 25px;

  text-align: center;

  border-radius: 18px;

  background:
    rgba(
      255,
      255,
      255,
      0.05
    );

  border:
    1px solid
    rgba(
      255,
      255,
      255,
      0.15
    );

}

.eyebrow {

  color: #E3B23C;

  font-size: 11px;

  letter-spacing: 3px;

  text-transform: uppercase;

  margin-bottom: 15px;

}

.icon {

  width: 60px;

  height: 60px;

  margin: auto;

  margin-bottom: 18px;

  display: flex;

  align-items: center;

  justify-content: center;

  border-radius: 50%;

  border:
    1px solid
    #C9A227;

  font-size: 26px;

}

h1 {

  font-size: 20px;

  margin:
    0 0 10px;

}

p {

  font-size: 14px;

  line-height: 1.5;

  color:
    rgba(
      237,
      231,
      217,
      0.7
    );

  margin-bottom: 24px;

}

button {

  width: 100%;

  padding: 14px;

  border: none;

  border-radius: 10px;

  background:
    #C9A227;

  color:
    #071320;

  font-size: 15px;

  font-weight: bold;

}

button:disabled {

  opacity: 0.6;

}

</style>

</head>

<body>

<div class="card">

${getMobileContent(
  state,
  sessionId
)}

</div>

</body>

</html>

`;

  return html;
}

/*
==================================================
MOBILE CONTENT
==================================================
*/

function getMobileContent(
  state,
  sessionId
) {

  /*
  ----------------------------------------------
  VALID QR
  ----------------------------------------------
  */

  if (
    state ===
    "confirm"
  ) {

    return `

<div class="eyebrow">
  Handset
</div>

<div class="icon">
  🔗
</div>

<h1>
  Link Device
</h1>

<p>
  Tap the button below to continue.
</p>

<button
  id="linkButton"
  onclick="linkDevice()"
>
  Link Device
</button>

<script>

async function linkDevice() {

  const button =
    document.getElementById(
      "linkButton"
    );

  button.disabled =
    true;

  button.textContent =
    "Your account is linking...";

  try {

    const response =
      await fetch(
        "/link/${sessionId}/confirm",
        {
          method: "POST"
        }
      );

    const result =
      await response.json();

    if (!result.ok) {

      button.disabled =
        false;

      button.textContent =
        "Link Device";

      alert(
        "This QR code has expired. Please scan the latest QR code."
      );

      return;

    }

    /*
    Keep message visible
    for exactly 3 seconds.
    */

    setTimeout(
      () => {

        window.location.href =
          "${DESTINATION_URL}";

      },
      3000
    );

  }

  catch (error) {

    button.disabled =
      false;

    button.textContent =
      "Link Device";

    alert(
      "Connection error. Please try again."
    );

  }

}

</script>

`;

  }

  /*
  ----------------------------------------------
  EXPIRED
  ----------------------------------------------
  */

  if (
    state ===
    "expired"
  ) {

    return `

<div class="eyebrow">
  QR Code
</div>

<div class="icon">
  ⌛
</div>

<h1>
  QR Code Expired
</h1>

<p>
  This QR code is no longer active.
  Please scan the latest QR code.
</p>

`;

  }

  /*
  ----------------------------------------------
  USED
  ----------------------------------------------
  */

  if (
    state ===
    "used"
  ) {

    return `

<div class="eyebrow">
  QR Code
</div>

<div class="icon">
  ✓
</div>

<h1>
  QR Code Already Used
</h1>

<p>
  Please scan the latest QR code.
</p>

`;

  }

  return `

<div class="eyebrow">
  QR Code
</div>

<div class="icon">
  !
</div>

<h1>
  QR Code Not Found
</h1>

<p>
  Please scan the latest QR code.
</p>

`;

}

/*
==================================================
SERVER START
==================================================
*/

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log(
      "================================"
    );

    console.log(
      "Sealine QR Server Running"
    );

    console.log(
      "================================"
    );

    console.log(
      `Local: http://localhost:${PORT}`
    );

    const ip =
      getLocalIP();

    if (ip) {

      console.log(
        `Network: http://${ip}:${PORT}`
      );

    }

    console.log(
      `Public: ${PUBLIC_BASE_URL}`
    );

    console.log(
      "QR lifetime: 60 seconds"
    );

    console.log(
      "================================"
    );

  }
);