import { api } from '../shared/api';
import { getAccount, getSettings, setAccount, type Account } from '../shared/settings';

/**
 * Connecting the extension: tapeshelf's own window at /connect/extension, where a signed-in
 * person presses one button. The window comes back with a one-time code bound to a PKCE challenge,
 * which the extension trades for its token. Runs in the service worker, which outlives the popup.
 */
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const random = (n: number) => base64url(crypto.getRandomValues(new Uint8Array(n)));

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

let connecting: Promise<Account | null> | null = null;

/** Opens the window; resolves with the account, or null when the person closed or cancelled it. */
export function connect(): Promise<Account | null> {
  connecting ??= run().finally(() => (connecting = null));
  return connecting;
}

async function run(): Promise<Account | null> {
  const { server } = await getSettings();
  const redirectUri = chrome.identity.getRedirectURL();
  const verifier = random(32);
  const state = random(16);
  const url = new URL('/connect/extension', server);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await challengeOf(verifier));
  // Signing in may take a while (a password, a second step); an API call now and then keeps the
  // service worker awake meanwhile.
  const awake = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  let back: string | undefined;
  try {
    back = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  } catch {
    return null;
  } finally {
    clearInterval(awake);
  }
  const answer = new URL(back ?? redirectUri);
  const code = answer.searchParams.get('code');
  if (!code || answer.searchParams.get('state') !== state) return null;
  const res = await fetch(`${server}/api/app-tokens/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier: verifier, redirectUri }),
    credentials: 'omit',
  });
  if (!res.ok) return null;
  const issued = (await res.json()) as Pick<Account, 'token' | 'user'>;
  const account: Account = { server, token: issued.token, user: issued.user };
  await setAccount(account);
  return account;
}

/** Disconnects: the token is revoked on the server (when it answers) and forgotten here. */
export async function disconnect(): Promise<void> {
  const account = await getAccount();
  await setAccount(null);
  if (account) await api(account, 'DELETE', '/app-tokens/current').catch(() => undefined);
}
