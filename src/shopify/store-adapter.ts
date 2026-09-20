import { getConfig, type StoreConfig } from '../config.js';
import { shopifyGraphQL, assertNoUserErrors, type UserError } from './client.js';

const VARIANTS_BY_SKU = `
  query VariantsBySku($query: String!) {
    productVariants(first: 250, query: $query) {
      nodes {
        id
        sku
        price
        product { id handle }
      }
    }
  }
`;

const UPDATE_VARIANT_PRICE = `
  mutation UpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku price }
      userErrors { field message code }
    }
  }
`;

export interface StoreVariant {
  sku: string;
  variantGid: string;
  productGid: string;
  price: string;
}

interface VariantNode {
  id: string;
  sku: string | null;
  price: string;
  product: { id: string; handle: string };
}

export interface StoreAdapter {
  readonly key: string;
  readonly label: string;
  readonly domain: string;
  query<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
  fetchVariants(skus: string[]): Promise<Map<string, StoreVariant>>;
  updateVariantPrice(productGid: string, variantGid: string, price: string): Promise<StoreVariant>;
}

function createAdapter(store: StoreConfig): StoreAdapter {
  return {
    key: store.key,
    label: store.label,
    domain: store.domain,

    query<T>(document: string, variables?: Record<string, unknown>) {
      return shopifyGraphQL<T>(store, document, variables);
    },

    async fetchVariants(skus) {
      if (skus.length === 0) return new Map();

      const data = await shopifyGraphQL<{ productVariants: { nodes: VariantNode[] } }>(store, VARIANTS_BY_SKU, {
        query: skus.map((s) => `sku:${s}`).join(' OR '),
      });

      const bySku = new Map<string, StoreVariant>();
      for (const node of data.productVariants.nodes) {
        if (!node.sku) continue;
        bySku.set(node.sku, {
          sku: node.sku,
          variantGid: node.id,
          productGid: node.product.id,
          price: node.price,
        });
      }
      return bySku;
    },

    async updateVariantPrice(productGid, variantGid, price) {
      const data = await shopifyGraphQL<{
        productVariantsBulkUpdate: { productVariants: VariantNode[]; userErrors: UserError[] };
      }>(store, UPDATE_VARIANT_PRICE, {
        productId: productGid,
        variants: [{ id: variantGid, price }],
      });

      assertNoUserErrors('productVariantsBulkUpdate', store.key, data.productVariantsBulkUpdate.userErrors);

      const updated = data.productVariantsBulkUpdate.productVariants[0];
      if (!updated) {
        throw new Error(`productVariantsBulkUpdate on "${store.key}" returned no variant for ${variantGid}.`);
      }

      return { sku: updated.sku ?? '', variantGid: updated.id, productGid, price: updated.price };
    },
  };
}

let adapters: StoreAdapter[] | null = null;

export function getStoreAdapters(): StoreAdapter[] {
  if (adapters === null) adapters = getConfig().stores.map(createAdapter);
  return adapters;
}
