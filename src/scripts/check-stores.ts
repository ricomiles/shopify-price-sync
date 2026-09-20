import { getConfigOrExit, type StoreConfig } from '../config.js';
import { getAccessToken, getGrantedScopes } from '../shopify/token.js';

const SHOP_QUERY = `
  query CheckStore {
    shop {
      name
      myshopifyDomain
      currencyCode
    }
  }
`;

interface ShopResponse {
  data?: { shop?: { name: string; myshopifyDomain: string; currencyCode: string } };
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

async function checkStore(store: StoreConfig, apiVersion: string) {
  const url = `https://${store.domain}/admin/api/${apiVersion}/graphql.json`;

  const accessToken = await getAccessToken(store);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query: SHOP_QUERY }),
  });

  if (res.status === 401) {
    throw new Error('401 Unauthorized - token was issued but rejected. Re-check the app is installed and released with the right scopes.');
  }
  if (res.status === 404) {
    throw new Error(`404 Not Found - check the domain, and that API version ${apiVersion} exists.`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const body = (await res.json()) as ShopResponse;

  if (body.errors?.length) {
    const codes = body.errors.map((e) => e.extensions?.code ?? 'ERROR').join(', ');
    throw new Error(`${codes}: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!body.data?.shop) {
    throw new Error('Unexpected response shape - no shop returned.');
  }

  return body.data.shop;
}

async function main() {
  const config = getConfigOrExit();

  console.log(`API version: ${config.shopifyApiVersion}`);
  console.log(`Stores configured: ${config.stores.length}\n`);

  const results = await Promise.allSettled(
    config.stores.map((store) => checkStore(store, config.shopifyApiVersion)),
  );

  const currencies = new Set<string>();
  let failed = false;

  results.forEach((result, i) => {
    const store = config.stores[i]!;
    if (result.status === 'fulfilled') {
      const shop = result.value;
      currencies.add(shop.currencyCode);
      console.log(`  OK    ${store.key.padEnd(10)} ${shop.name} (${shop.myshopifyDomain}) - ${shop.currencyCode}`);
      console.log(`        scopes: ${getGrantedScopes(store.key) || '(none reported)'}`);
    } else {
      failed = true;
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(`  FAIL  ${store.key.padEnd(10)} ${store.domain}`);
      console.error(`        ${reason}`);
    }
  });

  if (failed) {
    console.error('\nOne or more stores failed. See the troubleshooting table in docs/SETUP.md step 7.');
    process.exitCode = 1;
    return;
  }

  if (currencies.size > 1) {
    console.error(
      `\nWARNING: stores report different currencies (${[...currencies].join(', ')}).\n` +
        `A single central price per SKU assumes one shared currency. Fix this in\n` +
        `Settings > General > Store currency before seeding. See docs/SETUP.md step 2.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nAll stores reachable. Shared currency: ${[...currencies][0]}`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
