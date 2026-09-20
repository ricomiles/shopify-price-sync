import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { getStoreAdapters } from '../shopify/store-adapter.js';
import type { StoreVariantInfo } from '../shopify/variants.js';

export type StorePriceState = 'match' | 'mismatch' | 'unmapped' | 'unreachable';

export interface StorePriceView {
  status: StorePriceState;
  livePrice: string | null;
  lastSyncedPrice: string | null;
  syncStatus: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface SkuPriceView {
  sku: string;
  title: string;
  price: string;
  updatedAt: string;
  stores: Record<string, StorePriceView>;
  hasMismatch: boolean;
}

export interface StoreStatus {
  key: string;
  label: string;
  reachable: boolean;
  error?: string;
}

export interface PriceReport {
  stores: StoreStatus[];
  prices: SkuPriceView[];
  summary: { skus: number; mismatched: number; unreachable: number };
}

function samePrice(central: Prisma.Decimal, live: string): boolean {
  try {
    return central.equals(new Prisma.Decimal(live));
  } catch {
    return false;
  }
}

export async function getPriceReport(): Promise<PriceReport> {
  const skus = await prisma.sku.findMany({
    orderBy: { sku: 'asc' },
    include: { storeVariants: true },
  });

  const adapters = getStoreAdapters();
  const skuIds = skus.map((s) => s.sku);

  const liveByStore = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        const live = await adapter.fetchLivePrices(skuIds);
        return { adapter, live, error: null as string | null };
      } catch (err) {
        return {
          adapter,
          live: new Map<string, StoreVariantInfo>(),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const storeStatuses: StoreStatus[] = liveByStore.map(({ adapter, error }) => ({
    key: adapter.key,
    label: adapter.label,
    reachable: error === null,
    ...(error ? { error } : {}),
  }));

  const prices: SkuPriceView[] = skus.map((sku) => {
    const stores: Record<string, StorePriceView> = {};
    let hasMismatch = false;

    for (const { adapter, live, error } of liveByStore) {
      const mapping = sku.storeVariants.find((v) => v.storeKey === adapter.key);
      const liveVariant = live.get(sku.sku);

      let status: StorePriceState;
      if (error !== null) {
        status = 'unreachable';
      } else if (!mapping || !liveVariant) {
        status = 'unmapped';
      } else if (samePrice(sku.price, liveVariant.price)) {
        status = 'match';
      } else {
        status = 'mismatch';
        hasMismatch = true;
      }

      stores[adapter.key] = {
        status,
        livePrice: liveVariant?.price ?? null,
        lastSyncedPrice: mapping?.lastSyncedPrice?.toFixed(2) ?? null,
        syncStatus: mapping?.syncStatus ?? null,
        lastSyncedAt: mapping?.lastSyncedAt?.toISOString() ?? null,
        lastError: mapping?.lastError ?? null,
      };
    }

    return {
      sku: sku.sku,
      title: sku.title,
      price: sku.price.toFixed(2),
      updatedAt: sku.updatedAt.toISOString(),
      stores,
      hasMismatch,
    };
  });

  return {
    stores: storeStatuses,
    prices,
    summary: {
      skus: prices.length,
      mismatched: prices.filter((p) => p.hasMismatch).length,
      unreachable: storeStatuses.filter((s) => !s.reachable).length,
    },
  };
}
