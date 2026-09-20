import 'dotenv/config';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface StoreConfig {
  key: string;
  label: string;
  domain: string;
  clientId: string;
  clientSecret: string;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  shopifyApiVersion: string;
  stores: StoreConfig[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new ConfigError(`Missing required environment variable: ${name}. See .env.example`);
  }
  return value.trim();
}

const MAX_STORE_SCAN = 20;
s
function loadStores(): StoreConfig[] {
  const stores: StoreConfig[] = [];

  for (let i = 1; ; i++) {
    const domain = process.env[`STORE_${i}_DOMAIN`];
    if (!domain || domain.trim() === '') break;

    const key = required(`STORE_${i}_KEY`);
    const clientId = required(`STORE_${i}_CLIENT_ID`);
    const clientSecret = required(`STORE_${i}_CLIENT_SECRET`);

    const trimmedDomain = domain
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .toLowerCase();

    if (!trimmedDomain.endsWith('.myshopify.com')) {
      throw new ConfigError(
        `STORE_${i}_DOMAIN must be the *.myshopify.com admin domain, got "${domain.trim()}". ` +
          `A custom storefront domain will not authenticate against the Admin API.`,
      );
    }
s
    if (clientId.includes('replace_me') || clientSecret.includes('replace_me')) {
      throw new ConfigError(
        `STORE_${i}_CLIENT_ID / STORE_${i}_CLIENT_SECRET are still the .env.example placeholders. ` +
          `Copy them from the app's Settings page in the Dev Dashboard. See docs/SETUP.md step 3.`,
      );
    }

    stores.push({
      key,
      label: process.env[`STORE_${i}_LABEL`]?.trim() || key,
      domain: trimmedDomain,
      clientId,
      clientSecret,
    });
  }

  if (stores.length === 0) {
    throw new ConfigError('No stores configured. Set STORE_1_* in .env - see .env.example');
  }

  const nextIndex = stores.length + 1;
  const orphans: string[] = [];
  for (let i = nextIndex + 1; i <= nextIndex + MAX_STORE_SCAN; i++) {
    if (process.env[`STORE_${i}_DOMAIN`]?.trim()) orphans.push(`STORE_${i}_*`);
  }
  if (orphans.length > 0) {
    throw new ConfigError(
      `Gap in store numbering: STORE_${nextIndex}_DOMAIN is unset, but ${orphans.join(', ')} ${orphans.length === 1 ? 'is' : 'are'} defined. ` +
        `Stores are read in order and enumeration stops at the first gap, so ${orphans.length === 1 ? 'that store' : 'those stores'} ` +
        `would never be synced. Renumber them to be contiguous from STORE_1.`,
    );
  }

  const keys = stores.map((s) => s.key);
  const duplicates = [...new Set(keys.filter((k, idx) => keys.indexOf(k) !== idx))];
  if (duplicates.length > 0) {
    throw new ConfigError(
      `Duplicate STORE_*_KEY values: ${duplicates.join(', ')}. ` +
        `Keys are used as database identifiers and must be unique.`,
    );
  }

  return stores;
}

function build(): AppConfig {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`PORT must be a valid port number, got "${process.env.PORT}"`);
  }

  return {
    port,
    databaseUrl: required('DATABASE_URL'),
    shopifyApiVersion: process.env.SHOPIFY_API_VERSION?.trim() || '2026-07',
    stores: loadStores(),
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached === null) cached = build();
  return cached;
}

export function getConfigOrExit(): AppConfig {
  try {
    return getConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\nConfiguration error\n\n  ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}
