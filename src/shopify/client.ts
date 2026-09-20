import { getConfig, type StoreConfig } from '../config.js';
import { getAccessToken } from './token.js';

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface QueryCost {
  requestedQueryCost: number;
  actualQueryCost?: number;
  throttleStatus: ThrottleStatus;
}

export interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

interface GraphQLError {
  message: string;
  extensions?: { code?: string; cost?: QueryCost };
}

interface GraphQLBody<T> {
  data?: T;
  errors?: GraphQLError[];
  extensions?: { cost?: QueryCost };
}

export class ShopifyError extends Error {
  override name = 'ShopifyError';
  constructor(
    message: string,
    readonly storeKey: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class ShopifyUserError extends Error {
  override name = 'ShopifyUserError';
  constructor(
    readonly mutation: string,
    readonly storeKey: string,
    readonly userErrors: UserError[],
  ) {
    super(
      `${mutation} on "${storeKey}" rejected the input: ` +
        userErrors
          .map((e) => `${e.field?.join('.') ?? 'input'}: ${e.message}${e.code ? ` (${e.code})` : ''}`)
          .join('; '),
    );
  }
}

const MAX_ATTEMPTS = 5;
const MAX_THROTTLE_WAIT_MS = 15_000;
const NON_RETRYABLE_CODES = new Set(['ACCESS_DENIED', 'MAX_COST_EXCEEDED', 'GRAPHQL_VALIDATION_FAILED']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 250, 8_000) + Math.random() * 250;
}

function throttleWaitMs(cost: QueryCost | undefined): number {
  if (!cost) return 1_000;
  const { currentlyAvailable, restoreRate } = cost.throttleStatus;
  const shortfall = cost.requestedQueryCost - currentlyAvailable;
  if (shortfall <= 0 || restoreRate <= 0) return 1_000;
  return Math.min(Math.ceil((shortfall / restoreRate) * 1000) + 250, MAX_THROTTLE_WAIT_MS);
}

export async function shopifyGraphQL<T>(
  store: StoreConfig,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const { shopifyApiVersion } = getConfig();
  const url = `https://${store.domain}/admin/api/${shopifyApiVersion}/graphql.json`;
  let forceNewToken = false;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const token = await getAccessToken(store, forceNewToken);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });

    if (res.status === 401) {
      if (forceNewToken) {
        throw new ShopifyError(`401 Unauthorized from "${store.key}" even with a fresh token.`, store.key, false);
      }
      forceNewToken = true;
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastError = new ShopifyError(`HTTP ${res.status} from "${store.key}".`, store.key, true);
      await sleep(backoffMs(attempt));
      continue;
    }

    if (!res.ok) {
      throw new ShopifyError(
        `HTTP ${res.status} from "${store.key}": ${(await res.text()).slice(0, 200)}`,
        store.key,
        false,
      );
    }

    const body = (await res.json()) as GraphQLBody<T>;

    if (body.errors?.length) {
      const codes = body.errors.map((e) => e.extensions?.code).filter(Boolean) as string[];
      const message = body.errors.map((e) => e.message).join('; ');

      if (codes.includes('THROTTLED')) {
        const cost = body.extensions?.cost ?? body.errors.find((e) => e.extensions?.cost)?.extensions?.cost;
        lastError = new ShopifyError(`Throttled by "${store.key}".`, store.key, true);
        await sleep(throttleWaitMs(cost));
        continue;
      }

      const fatal = codes.find((c) => NON_RETRYABLE_CODES.has(c));
      if (fatal === 'ACCESS_DENIED') {
        throw new ShopifyError(
          `Access denied on "${store.key}": ${message}. The app's released version is probably ` +
            `missing a scope - see docs/SETUP.md step 3.`,
          store.key,
          false,
        );
      }
      throw new ShopifyError(`${codes.join(', ') || 'GraphQL error'} from "${store.key}": ${message}`, store.key, false);
    }

    if (!body.data) {
      throw new ShopifyError(`Empty response body from "${store.key}".`, store.key, false);
    }

    return body.data;
  }

  throw lastError ?? new ShopifyError(`Exhausted ${MAX_ATTEMPTS} attempts against "${store.key}".`, store.key, true);
}

export function assertNoUserErrors(mutation: string, storeKey: string, userErrors: UserError[] | undefined): void {
  if (userErrors && userErrors.length > 0) {
    throw new ShopifyUserError(mutation, storeKey, userErrors);
  }
}
