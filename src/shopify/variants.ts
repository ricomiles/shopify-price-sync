import { type StoreConfig } from '../config.js';
import { shopifyGraphQL } from './client.js';

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

export interface StoreVariantInfo {
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

export async function fetchVariantsBySku(
  store: StoreConfig,
  skus: string[],
): Promise<Map<string, StoreVariantInfo>> {
  if (skus.length === 0) return new Map();

  const data = await shopifyGraphQL<{ productVariants: { nodes: VariantNode[] } }>(store, VARIANTS_BY_SKU, {
    query: skus.map((s) => `sku:${s}`).join(' OR '),
  });

  const bySku = new Map<string, StoreVariantInfo>();
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
}
