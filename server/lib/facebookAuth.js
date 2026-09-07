/**
 * Facebook Login for Business (a "configuration") using the OAuth code
 * flow: the client gets a short-lived `code` from FB.login, and this
 * exchanges it server-side for an access token — the one step that
 * actually needs the app secret, so it can never happen in the browser.
 */
const GRAPH = 'https://graph.facebook.com/v20.0';

export const facebookSignInConfigured = () => Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);

/** Returns { id, name, email? } from Facebook's Graph API, or throws with a
 *  `status` an Express error handler can use directly. */
export async function exchangeFacebookCode(code) {
  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appId || !appSecret) {
    throw Object.assign(new Error('Facebook sign-in is not configured'), { status: 503, code: 'facebook_not_configured' });
  }

  // redirect_uri is deliberately empty: this code came from the JS SDK's
  // dialog flow (FB.login), not a server-side redirect, so there is no
  // redirect URI to match against.
  const tokenUrl = `${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}&redirect_uri=&code=${encodeURIComponent(code)}`;
  const tokenRes = await fetch(tokenUrl);
  const tokenJson = await tokenRes.json().catch(() => null);
  if (!tokenRes.ok || !tokenJson?.access_token) {
    throw Object.assign(new Error(tokenJson?.error?.message || 'Facebook token exchange failed'), { status: 400, code: 'facebook_auth_failed' });
  }

  const meRes = await fetch(`${GRAPH}/me?fields=id,name,email&access_token=${encodeURIComponent(tokenJson.access_token)}`);
  const me = await meRes.json().catch(() => null);
  if (!meRes.ok || !me?.id) {
    throw Object.assign(new Error(me?.error?.message || 'Failed to load the Facebook profile'), { status: 400, code: 'facebook_auth_failed' });
  }
  return me;
}
