/**
 * Verifies a Microsoft identity platform ID token server-side — the same
 * approach as googleAuth.js (Node's own crypto imports the JWK directly, no
 * extra dependency), just pointed at Microsoft's multi-tenant JWKS and issuer
 * shape instead of Google's fixed one.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const CERTS_URL = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache = { keys: [], fetchedAt: 0 };

// A "common" (multi-tenant) app is issued tokens by whichever tenant the
// user signed in through, so the issuer is only fixed in shape, not value —
// https://login.microsoftonline.com/<tenant-guid-or-"consumers"/"9188040d-...">/v2.0
const ISSUER_RE = /^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/;

async function getMicrosoftKeys() {
  if (cache.keys.length && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.keys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Failed to fetch Microsoft certs (${res.status})`);
  const { keys } = await res.json();
  cache = { keys, fetchedAt: Date.now() };
  return keys;
}

export const microsoftSignInConfigured = () => Boolean(process.env.MICROSOFT_CLIENT_ID);

/** Returns the token payload (sub, email/preferred_username, name, …) or
 *  throws with a `status` an Express error handler can use directly. */
export async function verifyMicrosoftIdToken(token) {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) throw Object.assign(new Error('Microsoft sign-in is not configured'), { status: 503, code: 'microsoft_not_configured' });

  const decoded = jwt.decode(String(token || ''), { complete: true });
  if (!decoded) throw Object.assign(new Error('Malformed token'), { status: 400, code: 'microsoft_auth_failed' });

  const keys = await getMicrosoftKeys();
  const jwk = keys.find(k => k.kid === decoded.header.kid);
  if (!jwk) throw Object.assign(new Error('Unknown signing key'), { status: 400, code: 'microsoft_auth_failed' });

  const pem = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
  let payload;
  try {
    payload = jwt.verify(token, pem, { algorithms: ['RS256'], audience: clientId });
  } catch {
    throw Object.assign(new Error('Invalid or expired token'), { status: 400, code: 'microsoft_auth_failed' });
  }
  if (!ISSUER_RE.test(payload.iss || '')) {
    throw Object.assign(new Error('Unexpected issuer'), { status: 400, code: 'microsoft_auth_failed' });
  }
  return payload;
}
