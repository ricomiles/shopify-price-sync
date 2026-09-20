import { getConfigOrExit } from '../config.js';
import { assertNoUserErrors, type UserError } from '../shopify/client.js';
import { getStoreAdapters, type StoreAdapter } from '../shopify/store-adapter.js';
import { CATALOG, type CatalogItem } from '../catalog.js';

const EXISTING_PRODUCTS = `
  query ExistingProducts($query: String!) {
    products(first: 250, query: $query) {
      nodes {
        id
        handle
        variants(first: 1) { nodes { id } }
      }
    }
  }
`;

const CREATE_PRODUCT = `
  mutation CreateProduct($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        handle
        variants(first: 1) { nodes { id } }
      }
      userErrors { field message }
    }
  }
`;

const SET_PRICE_AND_SKU = `
  mutation SetPriceAndSku($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku price }
      userErrors { field message code }
    }
  }
`;

interface ProductNode {
  id: string;
  handle: string;
  variants: { nodes: Array<{ id: string }> };
}

function handleFor(item: CatalogItem): string {
  return item.sku.toLowerCase();
}

async function findProductsByHandle(adapter: StoreAdapter): Promise<Map<string, ProductNode>> {
  const data = await adapter.query<{ products: { nodes: ProductNode[] } }>(EXISTING_PRODUCTS, {
    query: CATALOG.map((i) => `handle:${handleFor(i)}`).join(' OR '),
  });
  return new Map(data.products.nodes.map((n) => [n.handle, n]));
}

async function createProduct(adapter: StoreAdapter, item: CatalogItem): Promise<ProductNode> {
  const data = await adapter.query<{
    productCreate: { product: ProductNode | null; userErrors: UserError[] };
  }>(CREATE_PRODUCT, {
    product: {
      title: item.title,
      handle: handleFor(item),
      status: 'ACTIVE',
      vendor: 'Price Sync Demo',
    },
  });

  assertNoUserErrors('productCreate', adapter.key, data.productCreate.userErrors);
  if (!data.productCreate.product) {
    throw new Error(`productCreate returned no product for ${item.sku} on "${adapter.key}".`);
  }
  return data.productCreate.product;
}

async function setPriceAndSku(
  adapter: StoreAdapter,
  productId: string,
  variantId: string,
  item: CatalogItem,
): Promise<void> {
  const data = await adapter.query<{
    productVariantsBulkUpdate: { userErrors: UserError[] };
  }>(SET_PRICE_AND_SKU, {
    productId,
    variants: [{ id: variantId, price: item.price, inventoryItem: { sku: item.sku } }],
  });

  assertNoUserErrors('productVariantsBulkUpdate', adapter.key, data.productVariantsBulkUpdate.userErrors);
}

async function seedStore(adapter: StoreAdapter): Promise<void> {
  console.log(`\n${adapter.label} (${adapter.domain})`);

  const [existingBySku, existingByHandle] = await Promise.all([
    adapter.fetchVariants(CATALOG.map((i) => i.sku)),
    findProductsByHandle(adapter),
  ]);

  let created = 0;
  let repaired = 0;
  let skipped = 0;

  for (const item of CATALOG) {
    const alreadySeeded = existingBySku.get(item.sku);
    if (alreadySeeded) {
      skipped++;
      console.log(`  skip    ${item.sku}  ${alreadySeeded.variantGid}`);
      continue;
    }

    const orphan = existingByHandle.get(handleFor(item));
    const product = orphan ?? (await createProduct(adapter, item));
    const variantId = product.variants.nodes[0]?.id;

    if (!variantId) {
      throw new Error(`Product ${product.id} for ${item.sku} on "${adapter.key}" has no default variant.`);
    }

    await setPriceAndSku(adapter, product.id, variantId, item);

    if (orphan) {
      repaired++;
      console.log(`  repair  ${item.sku}  ${variantId}`);
    } else {
      created++;
      console.log(`  create  ${item.sku}  ${variantId}`);
    }
  }

  console.log(`  -> created ${created}, repaired ${repaired}, already present ${skipped}`);
}

async function main() {
  getConfigOrExit();
  const adapters = getStoreAdapters();
  console.log(`Seeding ${CATALOG.length} SKUs into ${adapters.length} stores.`);

  for (const adapter of adapters) {
    await seedStore(adapter);
  }

  console.log('\nDone. Next: npm run seed:db');
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
