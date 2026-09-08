/**
 * Facebook sign-in using the access token FB.login() already hands back in
 * the browser — no code-exchange round trip, so there's no redirect_uri to
 * get wrong (the JS SDK's popup flow uses an internal one of its own that
 * can't reliably be reproduced server-side, which is what kept breaking the
 * earlier code-exchange approach). The app secret is still only ever used
 * server-side, to confirm via debug_token that the token really was issued
 * to this app before trusting the profile it points to.
 */
const GRAPH = 'https://graph.facebook.com/v20.0';

export const facebookSignInConfigured = () => Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);

/** Returns { id, name, email? } from Facebook's Graph API, or throws with a
 *  `status` an Express error handler can use directly. */
export async function verifyFacebookAccessToken(accessToken) {
  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appId || !appSecret) {
    throw Object.assign(new Error('Facebook sign-in is not configured'), { status: 503, code: 'facebook_not_configured' });
  }

  // Without this, anyone who obtained a valid Facebook access token for
  // ANY app (not just ours) could hand it to us and have it accepted —
  // debug_token confirms Facebook itself issued this exact token to our
  // app_id before we trust the profile it unlocks.
  const debugUrl = `${GRAPH}/debug_token?input_token=${encodeURIComponent(accessToken)}` +
    `&access_token=${encodeURIComponent(appId)}|${encodeURIComponent(appSecret)}`;
  const debugRes = await fetch(debugUrl);
  const debugJson = await debugRes.json().catch(() => null);
  const info = debugJson?.data;
  if (!debugRes.ok || !info?.is_valid || String(info.app_id) !== String(appId)) {
    throw Object.assign(new Error(debugJson?.error?.message || 'Invalid Facebook access token'), { status: 400, code: 'facebook_auth_failed' });
  }

  const meRes = await fetch(`${GRAPH}/me?fields=id,name,email&access_token=${encodeURIComponent(accessToken)}`);
  const me = await meRes.json().catch(() => null);
  if (!meRes.ok || !me?.id) {
    throw Object.assign(new Error(me?.error?.message || 'Failed to load the Facebook profile'), { status: 400, code: 'facebook_auth_failed' });
  }
  return me;
}
