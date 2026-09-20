# Shopify Price Sync

A central price source for SKUs shared across multiple Shopify stores. Update a
price once through the API, and the service pushes it to the matching variant in
every configured store.

- Node.js + TypeScript + Express
- PostgreSQL via Prisma
- Shopify GraphQL Admin API

## Requirements

- Node.js 20+
- PostgreSQL 14+
- Two Shopify development stores and a Dev Dashboard app

## Quick start

```bash
# 1. install
npm install

# 2. configure
cp .env.example .env      # then fill in the store domains and app credentials

# 3. create the database tables
npx prisma migrate dev

# 4. seed 10 SKUs into both stores, then record them locally
npm run seed:shopify
npm run seed:db

# 5. run
npm run dev
```

- UI: <http://localhost:3000>
- API: <http://localhost:3000/prices>

## Environment

Copy `.env.example` to `.env` and fill it in.

| Variable | Description |
|---|---|
| `PORT` | HTTP port. Defaults to `3000`. |
| `DATABASE_URL` | PostgreSQL connection string. |
| `SHOPIFY_API_VERSION` | Admin API version. Defaults to `2026-07`. |
| `STORE_n_KEY` | Short identifier for the store, e.g. `store-a`. |
| `STORE_n_LABEL` | Display name shown in the UI. |
| `STORE_n_DOMAIN` | The store's `*.myshopify.com` domain. |
| `STORE_n_CLIENT_ID` | Dev Dashboard app client ID. |
| `STORE_n_CLIENT_SECRET` | Dev Dashboard app client secret. |

Stores are numbered from `STORE_1_`. To add a third store, add a `STORE_3_`
block — no code changes.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the server with reload. |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm start` | Run the compiled build. |
| `npm run seed:shopify` | Create the 10 catalog products in every store. |
| `npm run seed:db` | Record central prices and each store's variant IDs. |
| `npm run db:migrate` | Run Prisma migrations. |
| `npm run typecheck` | Type-check without emitting. |

Both seeds are safe to re-run.

## API

### `GET /prices`

Returns every SKU with its central price, the price currently live in each
store, and whether they agree.

```bash
curl http://localhost:3000/prices
```

```json
{
  "stores": [
    { "key": "store-a", "label": "Store A (AU)", "reachable": true },
    { "key": "store-b", "label": "Store B (AU)", "reachable": true }
  ],
  "prices": [
    {
      "sku": "PS-001",
      "title": "Merino Crew Neck Sweater",
      "price": "129.95",
      "updatedAt": "2026-09-20T20:54:14.639Z",
      "stores": {
        "store-a": {
          "status": "match",
          "livePrice": "129.95",
          "lastSyncedPrice": "129.95",
          "syncStatus": "SYNCED",
          "lastSyncedAt": "2026-09-20T20:36:44.603Z",
          "lastError": null
        },
        "store-b": { "...": "same shape" }
      },
      "hasMismatch": false
    }
  ],
  "summary": { "skus": 10, "mismatched": 0, "unreachable": 0 }
}
```

Each store is reported as `match`, `mismatch`, `unmapped` or `unreachable`.

### `PATCH /prices/:sku`

Updates the central price and pushes it to every store.

```bash
curl -X PATCH http://localhost:3000/prices/PS-001 \
  -H 'Content-Type: application/json' \
  -d '{"price":"139.95"}'
```

```json
{
  "sku": "PS-001",
  "title": "Merino Crew Neck Sweater",
  "price": "139.95",
  "updatedAt": "2026-09-20T20:55:46.122Z",
  "stores": [
    {
      "store": "store-a",
      "label": "Store A (AU)",
      "status": "SYNCED",
      "price": "139.95",
      "syncedAt": "2026-09-20T20:55:46.132Z"
    },
    {
      "store": "store-b",
      "label": "Store B (AU)",
      "status": "FAILED",
      "error": "Product variant does not exist (PRODUCT_VARIANT_DOES_NOT_EXIST)"
    }
  ],
  "summary": { "synced": 1, "failed": 1 }
}
```

| Status | Meaning |
|---|---|
| `200` | Every store synced. |
| `207` | Some stores synced, some failed. Per-store detail is in `stores`. |
| `400` | Invalid price. |
| `404` | Unknown SKU. |

### `GET /health`

Returns `{ "ok": true, "stores": ["store-a", "store-b"] }`.

## UI

<http://localhost:3000> serves a single page listing all SKUs, the price live in
each store, and the sync status. Prices are editable inline.

## Project layout

```
src/
  catalog.ts       the 10 seeded SKUs
  config.ts        environment parsing and validation
  db.ts            Prisma client
  server.ts        Express setup
  routes/          HTTP endpoints
  services/        price sync and drift reporting
  shopify/         Admin API client, auth, per-store adapter
  scripts/         seed scripts
prisma/            schema and migrations
public/            the UI
```

