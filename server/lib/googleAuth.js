/**
 * Verifies a Google Identity Services ID token server-side, without the
 * google-auth-library dependency: Node's own crypto can import a JWK
 * directly (createPublicKey({format:'jwk'})), so all that's needed on top
 * is fetching Google's public keys and checking the token with jsonwebtoken
 * — both already used elsewhere in this codebase.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache = { keys: [], fetchedAt: 0 };

async function getGoogleKeys() {
  if (cache.keys.length && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.keys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Failed to fetch Google certs (${res.status})`);
  const { keys } = await res.json();
  cache = { keys, fetchedAt: Date.now() };
  return keys;
}

export const googleSignInConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID);

/** Returns the token payload (sub, email, email_verified, name, picture, …)
 *  or throws with a `status` an Express error handler can use directly. */
export async function verifyGoogleIdToken(token) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw Object.assign(new Error('Google sign-in is not configured'), { status: 503, code: 'google_not_configured' });

  const decoded = jwt.decode(String(token || ''), { complete: true });
  if (!decoded) throw Object.assign(new Error('Malformed token'), { status: 400, code: 'google_auth_failed' });

  const keys = await getGoogleKeys();
  const jwk = keys.find(k => k.kid === decoded.header.kid);
  if (!jwk) throw Object.assign(new Error('Unknown signing key'), { status: 400, code: 'google_auth_failed' });

  const pem = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
  try {
    return jwt.verify(token, pem, {
      algorithms: ['RS256'], audience: clientId, issuer: ['https://accounts.google.com', 'accounts.google.com']
    });
  } catch {
    throw Object.assign(new Error('Invalid or expired token'), { status: 400, code: 'google_auth_failed' });
  }
}
