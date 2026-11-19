// Email notifications. Configure SMTP_URL (e.g. smtps://user:app-password@smtp.gmail.com)
// and MAIL_FROM. Without SMTP_URL, emails are printed to the console instead.
const SMTP_URL = process.env.SMTP_URL;
const FROM = process.env.MAIL_FROM || 'Leafs Ticket Draft <no-reply@localhost>';
const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

let transport = null;
if (SMTP_URL) transport = require('nodemailer').createTransport(SMTP_URL);

async function send(to, subject, text, path = '/') {
  if (!to) return;
  const body = `${text}\n\n${APP_URL}/#${path}\n\n— Leafs Ticket Draft`;
  if (!transport) { console.log(`[mail:not-configured] to=${to} subject="${subject}"\n${body}\n`); return; }
  try { await transport.sendMail({ from: FROM, to, subject, text: body }); }
  catch (e) { console.error('[mail] failed:', e.message); }
}

module.exports = { send, enabled: !!transport, APP_URL };
