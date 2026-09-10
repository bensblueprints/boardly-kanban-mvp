// SMTP mailer for Boardly Cloud Sync token delivery, via nodemailer
// (Google Workspace / Gmail with an app password is the expected setup:
// enable 2FA on the sender account, then create an app password at
// https://myaccount.google.com/apppasswords).
//
// Port conventions (nodemailer standard):
//  - 465 → secure: true (implicit TLS)
//  - 587 → secure: false + requireTLS (STARTTLS, fail if TLS unavailable)

const nodemailer = require('nodemailer');

const SEND_TIMEOUT_MS = 10000;

const SUBJECT = 'Your Boardly Cloud Sync token';
const APP_URL = 'https://boardly.onetimesuite.com';

function plainBody(token) {
  return `Your Boardly Cloud Sync token

${token}

Paste it into Boardly → Settings → Sync → Connect to turn on cloud sync.

- One token works on unlimited computers.
- Keep it secret — anyone who has it can sync your boards.
- Getting a new token invalidates all previous ones.

Don't have the app yet? ${APP_URL}

— Boardly
`;
}

function htmlBody(token) {
  return `<p>Your Boardly Cloud Sync token</p>
<p><code style="display:block;background:#f4f5f7;border:1px solid #d8dce3;border-radius:6px;padding:12px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;word-break:break-all">${token}</code></p>
<p>Paste it into <strong>Boardly → Settings → Sync → Connect</strong> to turn on cloud sync.</p>
<ul>
<li>One token works on unlimited computers.</li>
<li>Keep it secret — anyone who has it can sync your boards.</li>
<li>Getting a new token invalidates all previous ones.</li>
</ul>
<p>Don't have the app yet? <a href="${APP_URL}">${APP_URL}</a></p>
<p>— Boardly</p>`;
}

// createTransport is injectable for tests; defaults to
// nodemailer.createTransport.
function createMailer({ host, port, user, pass, from, createTransport }) {
  const makeTransport = createTransport || ((opts) => nodemailer.createTransport(opts));
  const secure = Number(port) === 465;
  const transport = makeTransport({
    host: host || 'smtp.gmail.com',
    port: Number(port) || 465,
    secure,
    requireTLS: !secure,
    auth: { user, pass },
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  });

  // One-time transport check at boot, for logging only.
  async function verify() {
    await transport.verify();
    return true;
  }

  // Sends the token email. Rejects on timeout, network, auth, or recipient
  // errors — the caller catches, logs, and records the failure.
  async function sendTokenEmail(to, token) {
    return transport.sendMail({
      from,
      to,
      subject: SUBJECT,
      text: plainBody(token),
      html: htmlBody(token),
    });
  }

  return { sendTokenEmail, verify };
}

module.exports = { createMailer };
