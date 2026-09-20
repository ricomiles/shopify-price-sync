import { prisma } from '../db.js';
import { getStoreAdapters, type StoreAdapter } from '../shopify/store-adapter.js';
import type { StoreVariant } from '@prisma/client';
import { ShopifyError, ShopifyUserError } from '../shopify/client.js';

export interface StoreSyncResult {
  store: string;
  label: string;
  status: 'SYNCED' | 'FAILED';
  price?: string;
  error?: string;
  syncedAt?: string;
}

export interface PriceUpdateResult {
  sku: string;
  title: string;
  price: string;
  updatedAt: string;
  stores: StoreSyncResult[];
  summary: { synced: number; failed: number };
}

export class SkuNotFoundError extends Error {
  override name = 'SkuNotFoundError';
  constructor(readonly sku: string) {
    super(`No SKU "${sku}" in the central price source.`);
  }
}

function describeError(err: unknown): string {
  if (err instanceof ShopifyUserError) return err.message;
  if (err instanceof ShopifyError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function pushToStore(
  adapter: StoreAdapter,
  mapping: StoreVariant | undefined,
  price: string,
): Promise<StoreSyncResult> {
  if (!mapping) {
    const error = `No variant mapping for this SKU in store "${adapter.key}". Run: npm run seed:db`;
    return { store: adapter.key, label: adapter.label, status: 'FAILED', error };
  }

  const attemptedAt = new Date();

  try {
    const updated = await adapter.updateVariantPrice(mapping.productGid, mapping.variantGid, price);

    await prisma.storeVariant.update({
      where: { id: mapping.id },
      data: {
        lastSyncedPrice: updated.price,
        syncStatus: 'SYNCED',
        lastError: null,
        lastAttemptAt: attemptedAt,
        lastSyncedAt: attemptedAt,
      },
    });

    return {
      store: adapter.key,
      label: adapter.label,
      status: 'SYNCED',
      price: updated.price,
      syncedAt: attemptedAt.toISOString(),
    };
  } catch (err) {
    const error = describeError(err);

    await prisma.storeVariant.update({
      where: { id: mapping.id },
      data: {
        syncStatus: 'FAILED',
        lastError: error.slice(0, 1000),
        lastAttemptAt: attemptedAt,
      },
    });

    return { store: adapter.key, label: adapter.label, status: 'FAILED', error };
  }
}

export async function updatePrice(sku: string, price: string): Promise<PriceUpdateResult> {
  const existing = await prisma.sku.findUnique({ where: { sku } });
  if (!existing) throw new SkuNotFoundError(sku);

  const updated = await prisma.sku.update({
    where: { sku },
    data: { price },
    include: { storeVariants: true },
  });

  const results = await Promise.all(
    getStoreAdapters().map((adapter) =>
      pushToStore(
        adapter,
        updated.storeVariants.find((v) => v.storeKey === adapter.key),
        price,
      ),
    ),
  );

  return {
    sku: updated.sku,
    title: updated.title,
    price: updated.price.toFixed(2),
    updatedAt: updated.updatedAt.toISOString(),
    stores: results,
    summary: {
      synced: results.filter((r) => r.status === 'SYNCED').length,
      failed: results.filter((r) => r.status === 'FAILED').length,
    },
  };
}
