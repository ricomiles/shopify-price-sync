import { getConfigOrExit } from '../config.js';
import { prisma } from '../db.js';
import { CATALOG } from '../catalog.js';
import { getStoreAdapters } from '../shopify/store-adapter.js';

async function main() {
  const config = getConfigOrExit();
  const skus = CATALOG.map((i) => i.sku);

  console.log(`Recording ${CATALOG.length} SKUs and their per-store variant mapping.`);

  for (const item of CATALOG) {
    await prisma.sku.upsert({
      where: { sku: item.sku },
      create: { sku: item.sku, title: item.title, price: item.price },
      update: { title: item.title },
    });
  }
  console.log(`  central prices: ${CATALOG.length} rows (existing prices left as-is)`);

  const perStore = await Promise.all(
    getStoreAdapters().map(async (store) => ({
      store,
      variants: await store.fetchVariants(skus),
    })),
  );

  let missing = 0;

  for (const { store, variants } of perStore) {
    let linked = 0;

    for (const item of CATALOG) {
      const variant = variants.get(item.sku);

      if (!variant) {
        missing++;
        console.error(`  MISSING ${store.key.padEnd(10)} ${item.sku} - not found in this store`);
        continue;
      }

      await prisma.storeVariant.upsert({
        where: { storeKey_sku: { storeKey: store.key, sku: item.sku } },
        create: {
          storeKey: store.key,
          sku: item.sku,
          productGid: variant.productGid,
          variantGid: variant.variantGid,
          lastSyncedPrice: variant.price,
          syncStatus: variant.price === item.price ? 'SYNCED' : 'PENDING',
          lastSyncedAt: variant.price === item.price ? new Date() : null,
        },
        update: {
          productGid: variant.productGid,
          variantGid: variant.variantGid,
        },
      });
      linked++;
    }

    console.log(`  ${store.key.padEnd(10)} linked ${linked}/${CATALOG.length} variants`);
  }

  if (missing > 0) {
    console.error(`\n${missing} SKU/store pairs are missing. Run: npm run seed:shopify`);
    process.exitCode = 1;
    return;
  }

  console.log('\nDone. Central prices and per-store variant mapping are recorded.');
}

main()
  .catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
