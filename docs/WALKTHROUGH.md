# Walkthrough

The reasoning behind this codebase: what it does, how a request flows through
it, why each decision was made, and where Shopify's actual behaviour differs
from what the documentation and most tutorials say.

Kept current as the build progresses. Status is marked per section.

---

## 1. What the service does

A central price source for SKUs shared across multiple Shopify stores. Update a
price once; the service pushes it to the matching variant in every store.

```
  PATCH /prices/:sku
        |
        v
  [ validate ]
        |
        v
  [ write to Postgres ]  <-- source of truth, committed before any store call
        |                   never rolled back by a store failure
        |
        +--> Store A: productVariantsBulkUpdate --> record per-store status
        +--> Store B: productVariantsBulkUpdate --> record per-store status
        |
        v
  response reflects what actually happened per store
```

The local write commits first. Store pushes are downstream effects, not part of
the same transaction — because there is no distributed transaction across
Shopify stores, and pretending otherwise would mean lying in the response.

---

## 2. File map

| Path | Role | Status |
|---|---|---|
| `src/config.ts` | Parses and validates `.env` once, at boot. | Built |
| `src/shopify/token.ts` | Client credentials grant, token cache. | Built |
| `prisma/schema.prisma` | Central prices + per-store variant mapping and status. | Built |
| `src/catalog.ts` | The 10 shared SKUs, titles and starting prices. | Built |
| `src/db.ts` | Prisma client. | Built |
| `src/shopify/client.ts` | Transport: GraphQL, cost-aware throttling, retries, `userErrors`. | Built |
| `src/scripts/seed-shopify.ts` | Creates 10 matching SKUs in both stores. | Built |
| `src/scripts/seed-db.ts` | Records central prices + the SKU→GID mapping. | Built |
| `src/shopify/store-adapter.ts` | One interface per store: shop info, variant lookup, price write. | Built |
| `src/services/price-sync.ts` | Central write + fan-out + per-store status. | Built |
| `src/routes/prices.ts` | `PATCH /prices/:sku` and validation. | Built |
| `src/server.ts` | Express wiring. | Built |
| `src/services/price-report.ts` | Drift detection for `GET /prices`. | Built |
| `public/index.html` | Minimal UI. | Built |

### Layering

One direction, no cycles:

```
routes  ->  services  ->  store-adapter  ->  client  ->  token
                    \->  db (prisma)
```

- **`client.ts`** is transport and knows nothing about prices: GraphQL over
  HTTP, throttling, retries, error classification.
- **`store-adapter.ts`** is *a store*. Everything Shopify-facing goes through an
  adapter instance — the app's operations are typed methods, and `query()` is a
  raw escape hatch for tooling such as the seed. Adding a store adds an
  instance, not a branch.
- **`services/`** hold the policy: what to write first, what to do on partial
  failure, what counts as drift.
- **`routes/`** only translate HTTP to and from services.

Scripts are tooling and sit outside the request path, but reuse the same
adapters rather than talking to Shopify their own way.

---

## 3. Data model

Two tables. Stores themselves are **not** a table — they live in `.env`, so
adding one stays a config change.

```
Sku                          StoreVariant
---                          ---
sku      (PK)   <----------  sku          (FK, cascade)
title                        storeKey      <-- matches STORE_n_KEY in .env
price    Decimal(10,2)       productGid
                             variantGid
                             lastSyncedPrice  Decimal(10,2)
                             syncStatus       PENDING | SYNCED | FAILED
                             lastError
                             lastSyncedAt
                             unique(storeKey, sku)
```

`Sku.price` is the intended price — the thing `PATCH` writes. `StoreVariant`
holds one row per store per SKU, carrying both the identifiers needed to write
to that store and the outcome of the last attempt.

Why both `productGid` and `variantGid`: `productVariantsBulkUpdate` takes
`productId` as a separate required argument, so the variant GID alone cannot
perform an update. Verified against the live schema by introspection:

```
productVariantsBulkUpdate(variants: [ProductVariantsBulkInput!]!, productId: ID!, ...)
```

Why per-store status rather than one status per SKU: store A can succeed while
store B fails. A single status column would have to lie about one of them.

---

## 4. Decisions

### GraphQL, not REST, for variant writes

The REST Admin API became a legacy API on 1 October 2024, and the REST
`/products` and `/variants` endpoints were deprecated in the 2024-04 release.
Variant prices are written with the **`productVariantsBulkUpdate`** GraphQL
mutation, never `PUT /admin/api/{version}/variants/{id}.json`.

Most copy-paste answers online still show the REST call. It works today, on
borrowed time, and it is the wrong thing to build new work on.

### Client credentials, not a static `shpat_` token

Shopify used to offer *admin-created custom apps*: created inside a store's
admin, revealing a long-lived `shpat_...` token exactly once. **That flow has
been removed — you can no longer create new admin-created custom apps.**

Apps are now created in the Dev Dashboard and hold a client ID and secret, which
are exchanged at runtime:

```
POST https://{shop}.myshopify.com/admin/oauth/access_token
  grant_type=client_credentials
  client_id=...
  client_secret=...

-> { "access_token": "...", "scope": "write_products", "expires_in": 86399 }
```

Consequences that shape the code:

- Tokens expire (~24h), so they are cached with an expiry and refreshed, not
  read from the environment. See `src/shopify/token.ts`.
- Concurrent cache misses are collapsed onto a single in-flight exchange —
  otherwise a cold-cache 10-SKU fan-out fires ten identical token requests.
- The OAuth endpoint is **not** versioned: no `/api/{version}/` segment.

### Pinned API version

`SHOPIFY_API_VERSION=2026-07` — the current stable release. Shopify ships a new
version quarterly and supports each for 12 months. Never "latest": an unpinned
request silently changes behaviour the day a version rolls.

### Stores are configuration, not code

Stores are read from numbered environment variables — `STORE_1_*`, `STORE_2_*` —
into an array. Every part of the system iterates that array rather than naming
stores individually, so **adding a third store is four lines of `.env` and no
code change.** That is the point of the exercise: the business runs multiple
stores and onboards more.

Two guards, both learned by nearly shipping the bug:

- Enumeration stops at the first gap, so a leftover `STORE_3_*` after deleting
  `STORE_2_*` would be silently ignored. A store that quietly drops out of the
  fan-out is a store that quietly keeps selling at the old price, so the config
  refuses to boot on a numbering gap.
- Domains are normalised (scheme, trailing path, case) because the address bar
  gives you `https://...`, and `https://https://...` is a confusing failure.

### Money is Decimal, never float

Prices are `Decimal(10,2)` in Postgres and decimal strings over the Shopify API.
`GET /prices` compares intended price against live price for equality, and
float drift in a price-comparison endpoint would produce phantom mismatches.

### Fail fast on configuration

A bad `.env` stops the process at boot with a readable message and no stack
trace. The alternative is a confusing 401 twenty minutes later, half way through
a fan-out, with one store already updated.

---

## 5. Shopify behaviour worth knowing

### HTTP 200 does not mean success

This is the single most important thing about the GraphQL Admin API, and it
shapes every call site.

| Situation | HTTP status | Where the failure actually is |
|---|---|---|
| Query succeeded | 200 | — |
| Rate limited | **200** | `errors[].extensions.code === "THROTTLED"` |
| Query too expensive | **200** | `errors[].extensions.code === "MAX_COST_EXCEEDED"` |
| Mutation rejected the input | **200** | `data.<mutation>.userErrors[]` |
| Missing scope | **200** | `errors[].extensions.code === "ACCESS_DENIED"` |
| Bad token | 401 | HTTP status |

Two direct consequences:

- **Retry logic cannot key off HTTP 429.** The REST API used 429; the GraphQL
  API returns 200 and a `THROTTLED` error code. A status-code-based retry would
  never fire at all.
- **Every mutation must check `userErrors`.** A rejected price write returns 200
  with an empty error array at the transport level. Skip that check and the sync
  status records success for a write that never happened — the worst possible
  failure mode for this service, because it reports green while the store sells
  at the wrong price.

### Throttling is a leaky bucket, priced by query cost

Each field has a cost; the total is deducted from a bucket that refills at a
fixed rate. Every response carries the current state:

```json
"extensions": {
  "cost": {
    "requestedQueryCost": 12,
    "actualQueryCost": 8,
    "throttleStatus": {
      "maximumAvailable": 2000.0,
      "currentlyAvailable": 1892.0,
      "restoreRate": 100.0
    }
  }
}
```

So backoff is computed, not guessed: read `currentlyAvailable` and `restoreRate`
and wait for the points needed. Reading the real restore rate also avoids
hardcoding plan-specific numbers that differ between dev, standard and Plus.

### The new product model

Since 2024-04, `productCreate` no longer accepts variants inline, and **SKU is
not a top-level variant field** — it lives under `inventoryItem.sku`. A product
created without variants gets an auto-created default variant, so naively
calling `productVariantsBulkCreate` afterwards leaves a stray one.

The seed therefore does `productCreate`, then `productVariantsBulkUpdate` on the
default variant to set its price and SKU — which has the pleasant side effect of
exercising the exact mutation the sync path uses.

Introspecting the live 2026-07 schema confirms all of this:

```
productCreate(product: ProductCreateInput, media: ...)

ProductCreateInput:      title, handle, status, vendor, productOptions, ...   (no `variants`)
ProductVariantsBulkInput: id, price, inventoryItem, optionValues, ...          (no `sku`)
InventoryItemInput:       sku, cost, tracked, ...
```

The seed is idempotent, and deliberately so — it's run during a demo. It looks
up existing variants by SKU and skips them. It also matches on a deterministic
handle (`ps-001`), so a product created by a previous run whose variant update
failed gets repaired rather than duplicated.

### Variant IDs differ per store

The same SKU is a different variant in each store, which is why the database
stores a per-store mapping rather than assuming a shared ID. Both the product
GID and the variant GID are stored: `productVariantsBulkUpdate` takes a
`productId` argument alongside the variants array, so the variant GID alone is
not enough to perform an update.

---

## 6. Where the documentation was wrong

Recorded because "I checked instead of assuming" is worth being able to
demonstrate, and because each cost real debugging time.

| Expectation | Reality |
|---|---|
| Custom app created in store admin, `shpat_` token | That flow is removed. Dev Dashboard + client credentials. |
| Retry on HTTP 429 | GraphQL throttling is HTTP 200 + `THROTTLED`. |
| "Create app" button is in the top right | On an empty org it is only in a banner at the bottom of the page. |
| Scopes are a checkbox list | Free-text field; scopes are typed comma-separated. |
| Blank page after install is harmless | Identical to an install that silently failed. Verify via token exchange. |
| Bad domain gives a JSON error | HTML error page; the reason is in the `<title>`. |

The last one mattered: a failed token exchange returned
`400 - Oauth error app_not_installed` buried inside an HTML document. The client
now parses that title and reports the reason, instead of blaming the domain.

---

## 7. Partial failure policy

Shopify gives us no distributed transaction across stores, so the service does
not pretend the operation is atomic. The policy, in order:

1. **The central write commits first.** `Sku.price` is the intended price and is
   authoritative. It is never rolled back because a store push failed — the
   intent was recorded, and the store is simply behind.
2. **Each store is pushed independently**, concurrently, and one store's failure
   cannot affect another's.
3. **Every attempt writes its outcome** to that store's `StoreVariant` row:
   `SYNCED` with `lastSyncedPrice` and `lastSyncedAt`, or `FAILED` with
   `lastError`. On failure `lastSyncedPrice` is deliberately left at the old
   value, because that is still what the store is charging.
4. **The response reports per store**, never a single collapsed status.

### Status codes

| Outcome | Status |
|---|---|
| Every store synced | `200 OK` |
| Some synced, some failed | `207 Multi-Status` |
| SKU not in the central source | `404 Not Found` |
| Invalid price | `400 Bad Request` |

`207` is the honest answer to a partial write. A `200` would claim a success
that didn't happen; a `500` would hide the store that did succeed and invite a
retry that re-pushes a price already live.

### Verified

Corrupting store B's variant GID and issuing a `PATCH`:

```
HTTP 207
store-a  SYNCED  199.00
store-b  FAILED  productVariantsBulkUpdate on "store-b" rejected the input:
                 variants.0.id: Product variant does not exist
                 (PRODUCT_VARIANT_DOES_NOT_EXIST)
```

The central price still moved to 199.00, store A went live, and store B's row
kept `lastSyncedPrice = 189.50` — the price it is actually still charging —
with the error recorded. Restoring the GID and re-issuing the same `PATCH`
returned both stores to `SYNCED` and cleared the error.

Note where that failure came from: **Shopify returned HTTP 200**. The rejection
was in `userErrors`. Without the `assertNoUserErrors` check, store B would have
been recorded as `SYNCED` at a price it never accepted — the service would have
reported green while the store sold at the old price.

---

## 8. Drift detection: `GET /prices`

Reports, per SKU, the intended central price against what is actually live in
each store. Intended state vs actual state — the two can diverge whenever
someone edits a price in a store admin, or a sync failed and was never retried.

### Four states, not two

A naive implementation has `mismatch: true | false`, which is wrong: it cannot
distinguish "this store disagrees" from "we could not ask this store".

| State | Meaning | Action |
|---|---|---|
| `match` | Live price equals the central price. | None. |
| `mismatch` | Live price differs. Real drift. | Re-sync. |
| `unmapped` | No variant mapping for this store/SKU. | `npm run seed:db` |
| `unreachable` | The store could not be queried at all. | Investigate the store. |

Reporting an unreachable store as a mismatch would be a lie that triggers
pointless re-syncs. The store-level `reachable` flag carries the error once,
rather than repeating it on all ten rows.

### Two requests, not twenty

Live prices are fetched with **one bulk query per store**, the stores in
parallel — not one query per SKU. Ten SKUs across two stores is 2 requests, not
20. Beyond being slow, the naive version is also the fastest way to trip the
rate limiter and then discover your throttle handling is wrong.

A store failing is caught per store, so one unreachable store still produces a
full report for the others.

### Comparison is decimal, not float

Prices are compared with `Prisma.Decimal.equals`, not `Number`. String
comparison would also be wrong: `"89.9"` and `"89.90"` are the same price and
must not be reported as drift.

### Verified

All four states were exercised against the live stores: a clean report (10/10
match), real drift created by changing the central price out of band, an
`unmapped` row created by deleting a mapping, and `unreachable` by pointing a
store at a domain that does not exist. With one store unreachable, the
mismatch count stayed accurate for the other.

The drift report also caught a bug in our own seed script: `seed:db` upserted
`Sku` rows with catalog prices on every run, silently overwriting prices set via
`PATCH` and manufacturing drift. It now only sets a price on insert.

---

## 9. The UI

One static file, `public/index.html`, served by `express.static`. No framework,
no build step, no dependencies — plain HTML, CSS and `fetch`. It is not what is
being assessed, so it is deliberately small, but it is the fastest way to *show*
drift and partial failure rather than describe them.

### Store columns are generated, not hardcoded

The table header is built by iterating `report.stores` from the API response.
Configure a third store in `.env` and a third column appears with no change to
the HTML — the same property the backend has, carried through to the UI.

### What it shows

- Central price per SKU, editable inline. Save enables only when the value is
  both valid and actually changed; Enter submits.
- Live price per store, with a state pill: *in sync*, *drift*, *not mapped*, or
  *unreachable* — the same four states the API reports.
- The Shopify error text under any store whose last sync failed, so a failure is
  diagnosable from the table rather than the server log.
- A summary pill, plus a per-store reachability pill.

Client-side validation mirrors the server's decimal rule, but the server
revalidates regardless — the browser check is a convenience, not the boundary.

### Verified in the browser

Loaded, edited a price, saved, and confirmed the row went green and both stores
updated. Also rendered with real drift and with one store's variant GID broken,
to confirm the drift and failure states are legible and not just present in the
JSON.

Two bugs were found and fixed by looking at it rather than trusting the code:
disabled Save buttons rendered as washed-out blue and read as clickable, and the
success confirmation was destroyed by the table refresh that followed it — the
sync worked but the user never saw it happen.

---

## 10. Production differences

*To be expanded for the README.* Webhook-driven reconciliation rather than
on-demand drift checks; a queue for the fan-out so a store outage retries
without holding the request open; idempotency keys on price updates; structured
logging and alerting on sustained sync failure; currency- and market-aware
pricing instead of one scalar per SKU.
