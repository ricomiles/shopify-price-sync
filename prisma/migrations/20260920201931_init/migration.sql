-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- CreateTable
CREATE TABLE "Sku" (
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sku_pkey" PRIMARY KEY ("sku")
);

-- CreateTable
CREATE TABLE "StoreVariant" (
    "id" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "lastSyncedPrice" DECIMAL(10,2),
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoreVariant_storeKey_idx" ON "StoreVariant"("storeKey");

-- CreateIndex
CREATE UNIQUE INDEX "StoreVariant_storeKey_sku_key" ON "StoreVariant"("storeKey", "sku");

-- AddForeignKey
ALTER TABLE "StoreVariant" ADD CONSTRAINT "StoreVariant_sku_fkey" FOREIGN KEY ("sku") REFERENCES "Sku"("sku") ON DELETE CASCADE ON UPDATE CASCADE;
