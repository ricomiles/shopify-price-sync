import { type StoreConfig } from '../config.js';

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const EXPIRY_MARGIN_MS = 60_000;

const cache = new Map<string, CachedToken>();

const inFlight = new Map<string, Promise<CachedToken>>();

async function requestToken(store: StoreConfig): Promise<CachedToken> {
  const res = await fetch(`https://${store.domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: store.clientId,
      client_secret: store.clientSecret,
    }),
  });

  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false;

  if (!res.ok) {
    if (!isJson) {
      const html = await res.text();
      const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
      const reason = title?.match(/Oauth error (\w+)/i)?.[1];

      if (reason === 'app_not_installed') {
        throw new Error(
          `App is not installed on "${store.domain}". The credentials and domain are fine - ` +
            `the app has no install on this store. In the Dev Dashboard: open the app, Home, ` +
            `Install app, pick this store. Confirm it appears under the store's Settings > Apps ` +
            `and sales channels afterwards. See docs/SETUP.md step 3.`,
        );
      }
      if (title) {
        throw new Error(`Token exchange failed for "${store.domain}": ${title}`);
      }
      throw new Error(
        `Store "${store.domain}" returned HTTP ${res.status} and a non-JSON body. ` +
          `If the domain is right, the store may be unavailable - check STORE_*_DOMAIN.`,
      );
    }

    const detail = (await res.text()).slice(0, 300);
    if (res.status === 400 || res.status === 401) {
      throw new Error(
        `Token exchange rejected for "${store.key}" (HTTP ${res.status}). Usual causes: wrong ` +
          `client ID/secret, the app was never installed on this store, or the store is not in the ` +
          `same organization as the app. Detail: ${detail}`,
      );
    }
    throw new Error(`Token exchange failed for "${store.key}": HTTP ${res.status} ${detail}`);
  }

  if (!isJson) {
    throw new Error(
      `Store "${store.domain}" returned HTTP ${res.status} but not JSON. Check STORE_*_DOMAIN.`,
    );
  }

  const body = (await res.json()) as Partial<TokenResponse>;
  if (!body.access_token || typeof body.expires_in !== 'number') {
    throw new Error(`Token exchange returned an unexpected body for "${store.key}".`);
  }

  return {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000 - EXPIRY_MARGIN_MS,
  };
}

export async function getAccessToken(store: StoreConfig, force = false): Promise<string> {
  if (!force) {
    const cached = cache.get(store.key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
  }

  const existing = inFlight.get(store.key);
  if (existing && !force) return (await existing).token;

  const pending = requestToken(store);
  inFlight.set(store.key, pending);

  try {
    const fresh = await pending;
    cache.set(store.key, fresh);
    return fresh.token;
  } finally {
    inFlight.delete(store.key);
  }
}
