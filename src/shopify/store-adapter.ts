import { getConfig, type StoreConfig } from '../config.js';
import { shopifyGraphQL, assertNoUserErrors, type UserError } from './client.js';
import { fetchVariantsBySku, type StoreVariantInfo } from './variants.js';

const UPDATE_VARIANT_PRICE = `
  mutation UpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku price }
      userErrors { field message code }
    }
  }
`;

interface VariantNode {
  id: string;
  sku: string | null;
  price: string;
}

export interface UpdatedVariant {
  variantGid: string;
  sku: string | null;
  price: string;
}

export interface StoreAdapter {
  readonly key: string;
  readonly label: string;
  readonly domain: string;
  updateVariantPrice(productGid: string, variantGid: string, price: string): Promise<UpdatedVariant>;
  fetchLivePrices(skus: string[]): Promise<Map<string, StoreVariantInfo>>;
}

function createAdapter(store: StoreConfig): StoreAdapter {
  return {
    key: store.key,
    label: store.label,
    domain: store.domain,

    async updateVariantPrice(productGid, variantGid, price) {
      const data = await shopifyGraphQL<{
        productVariantsBulkUpdate: {
          productVariants: VariantNode[];
          userErrors: UserError[];
        };
      }>(store, UPDATE_VARIANT_PRICE, {
        productId: productGid,
        variants: [{ id: variantGid, price }],
      });

      assertNoUserErrors('productVariantsBulkUpdate', store.key, data.productVariantsBulkUpdate.userErrors);

      const updated = data.productVariantsBulkUpdate.productVariants[0];
      if (!updated) {
        throw new Error(`productVariantsBulkUpdate on "${store.key}" returned no variant for ${variantGid}.`);
      }

      return { variantGid: updated.id, sku: updated.sku, price: updated.price };
    },

    async fetchLivePrices(skus) {
      return fetchVariantsBySku(store, skus);
    },
  };
}

let adapters: StoreAdapter[] | null = null;

export function getStoreAdapters(): StoreAdapter[] {
  if (adapters === null) {
    adapters = getConfig().stores.map(createAdapter);
  }
  return adapters;
}

export function getStoreAdapter(key: string): StoreAdapter | undefined {
  return getStoreAdapters().find((a) => a.key === key);
}
