/**
 * Outgoing email over SMTP (Brevo by default). Configured entirely through
 * env vars so a missing SMTP_* set degrades to a console warning instead of
 * crashing boot — the same "optional service" convention as UPLOAD_DIR and
 * the pluggable db backends.
 */
import nodemailer from 'nodemailer';

let transporter;

function getTransporter() {
  if (transporter !== undefined) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  transporter = (SMTP_HOST && SMTP_USER && SMTP_PASSWORD)
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(SMTP_PORT) || 587,
        secure: false, // 587 is STARTTLS, not implicit TLS
        auth: { user: SMTP_USER, pass: SMTP_PASSWORD }
      })
    : null;
  return transporter;
}

export async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) {
    console.warn(`[mail] SMTP not configured — skipped "${subject}" to ${to}`);
    return { skipped: true };
  }
  return t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html });
}
