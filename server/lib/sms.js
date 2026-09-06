/**
 * Outgoing SMS over Brevo's transactional SMS REST API. Same optional-service
 * convention as mail.js: no BREVO_API_KEY means a console warning, never a
 * crash. Uses the platform fetch — no SDK dependency needed for one endpoint.
 */
const BREVO_SMS_URL = 'https://api.brevo.com/v3/transactionalSMS/sms';

export async function sendSms(to, content) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn(`[sms] BREVO_API_KEY not configured — skipped SMS to ${to}`);
    return { skipped: true };
  }
  const res = await fetch(BREVO_SMS_URL, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: process.env.SMS_SENDER || 'DigiClass',
      recipient: String(to).replace(/^\+/, ''),
      content,
      type: 'transactional'
    })
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Brevo SMS failed (${res.status}): ${json?.message || 'unknown error'}`);
  return json;
}
