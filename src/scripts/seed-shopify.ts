import { getConfigOrExit, type StoreConfig } from '../config.js';
import { shopifyGraphQL, assertNoUserErrors, type UserError } from '../shopify/client.js';
import { CATALOG, type CatalogItem } from '../catalog.js';
import { fetchVariantsBySku } from '../shopify/variants.js';

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

const UPDATE_VARIANT = `
  mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
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

function buildOrQuery(field: string, values: string[]): string {
  return values.map((v) => `${field}:${v}`).join(' OR ');
}

async function findExistingProducts(store: StoreConfig): Promise<Map<string, ProductNode>> {
  const data = await shopifyGraphQL<{ products: { nodes: ProductNode[] } }>(store, EXISTING_PRODUCTS, {
    query: buildOrQuery('handle', CATALOG.map(handleFor)),
  });

  return new Map(data.products.nodes.map((n) => [n.handle, n]));
}

async function createProduct(store: StoreConfig, item: CatalogItem): Promise<ProductNode> {
  const data = await shopifyGraphQL<{
    productCreate: { product: ProductNode | null; userErrors: UserError[] };
  }>(store, CREATE_PRODUCT, {
    product: {
      title: item.title,
      handle: handleFor(item),
      status: 'ACTIVE',
      vendor: 'Price Sync Demo',
    },
  });

  assertNoUserErrors('productCreate', store.key, data.productCreate.userErrors);
  if (!data.productCreate.product) {
    throw new Error(`productCreate returned no product for ${item.sku} on "${store.key}".`);
  }
  return data.productCreate.product;
}

async function setPriceAndSku(
  store: StoreConfig,
  productId: string,
  variantId: string,
  item: CatalogItem,
): Promise<void> {
  const data = await shopifyGraphQL<{
    productVariantsBulkUpdate: {
      productVariants: Array<{ id: string; sku: string | null; price: string }>;
      userErrors: UserError[];
    };
  }>(store, UPDATE_VARIANT, {
    productId,
    variants: [
      {
        id: variantId,
        price: item.price,
        inventoryItem: { sku: item.sku },
      },
    ],
  });

  assertNoUserErrors('productVariantsBulkUpdate', store.key, data.productVariantsBulkUpdate.userErrors);
}

async function seedStore(store: StoreConfig): Promise<void> {
  console.log(`\n${store.label} (${store.domain})`);

  const [existingBySku, existingByHandle] = await Promise.all([
    fetchVariantsBySku(store, CATALOG.map((i) => i.sku)),
    findExistingProducts(store),
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
    const product = orphan ?? (await createProduct(store, item));
    const variantId = product.variants.nodes[0]?.id;

    if (!variantId) {
      throw new Error(`Product ${product.id} for ${item.sku} on "${store.key}" has no default variant.`);
    }

    await setPriceAndSku(store, product.id, variantId, item);

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
  const config = getConfigOrExit();
  console.log(`Seeding ${CATALOG.length} SKUs into ${config.stores.length} stores.`);

  for (const store of config.stores) {
    await seedStore(store);
  }

  console.log('\nDone. Next: npm run seed:db');
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
