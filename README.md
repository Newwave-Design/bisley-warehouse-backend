# Warehouse Management System — Backend

Node.js + Express + PostgreSQL API powering the Bisley WMS.  
Deployed on **Railway** — auto-deploys from `main` branch.  
Production: `https://bisley-warehouse-backend-production.up.railway.app`

---

## Quick Start

```bash
cd apps/warehouse-backend
npm install
cp .env.example .env.local   # fill in DATABASE_URL + JWT_SECRET
npm run db:migrate            # creates all tables (safe to re-run)
npm run dev                   # http://localhost:3001
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string (Railway provides this) |
| `JWT_SECRET` | ✅ | JWT signing secret |
| `MEDUSA_API_BASE_URL` | ✅ | Medusa backend URL (e.g. `https://bisley-shop.medusajs.app`) |
| `MEDUSA_ADMIN_EMAIL` | ✅ | Medusa admin email for product sync auth |
| `MEDUSA_ADMIN_PASSWORD` | ✅ | Medusa admin password |
| `GENERO_API_URL` | ⚠️ | Bisley New Wave API endpoint. When unset: **simulation mode** (no real calls) |
| `GENERO_ACCOUNT_NO` | ⚠️ | NW account number e.g. `NW123` |
| `MEDUSA_WEBHOOK_SECRET` | ⚠️ | HMAC secret for Medusa webhook signature verification |
| `UPS_CLIENT_ID` | ⚠️ | UPS app client ID for OAuth client credentials |
| `UPS_CLIENT_SECRET` | ⚠️ | UPS app client secret for OAuth client credentials |
| `UPS_ACCOUNT_NUMBER` | ⚠️ | UPS shipper account number |
| `UPS_ENVIRONMENT` | ⚠️ | `test` or `production` |
| `UPS_SHIP_API_VERSION` | ⚠️ | UPS ship endpoint version, default `v2403` |
| `PORT` | — | Server port (Railway sets this; defaults to 3001) |
| `NODE_ENV` | — | `production` enables strict JWT and Genero auto-poll |

---

## API Reference

All endpoints require `Authorization: Bearer <jwt>` except webhooks.  
Auth accepts any valid JWT or demo token (payload: `{ sub, email, role }`).

### Dashboard
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/dashboard` | Live stats for all WMS entities |

### Products (Medusa Sync)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/products` | Live fetch from Medusa (5-min memory cache) |
| `GET` | `/api/products/wms-cache` | Read from local `wms_products` table |
| `POST` | `/api/products/sync` | Pull all Medusa products into WMS DB (async background job) |
| `GET` | `/api/products/sync/status` | Poll sync job status and result |
| `GET` | `/api/products/:id/shipping-estimates` | Per-variant shipping cost estimates + service eligibility + requirements |
| `GET` | `/api/products/:id` | Single product from memory cache |

`/api/products/:id/shipping-estimates` assumptions:
- Packed dimensions include protective packaging allowance of +15 to +20 mm on each dimension.
- Eligibility and costing use the conservative +20 mm values.
- Service requirements are read from `shipping_services.constraints` (weight, size, girth+length, volume, package type).

### Mobile Scanner
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/mobile/lookup?q=` | Resolve any barcode/NW code → product info + stock by bay |
| `POST` | `/api/mobile/receive` | Stock in items to a bay (upsert inventory) |
| `POST` | `/api/mobile/move` | Move qty from one bay to another (two-leg, both reversed on undo) |
| `GET` | `/api/mobile/locations` | All bays with current unit count |
| `POST` | `/api/mobile/undo` | Reverse a receive or move (within 1 hour) |
| `GET` | `/api/mobile/pick-lists` | Open pick lists for mobile picker |
| `GET` | `/api/mobile/pick-lists/:id` | Pick list with thumbnails and bay locations per item |
| `POST` | `/api/mobile/pick-lists/:id/items/:itemId/pick` | Scan to confirm a pick (validates barcode vs expected SKU) |

### Webhooks
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/webhooks/medusa` | Medusa `order.placed` → auto-create pick list |
| `GET` | `/api/webhooks/test-order` | Create test pick list (dev only) |

Webhook-created pick lists now also snapshot customer and delivery metadata for downstream packing and shipping.

**Medusa webhook setup:** Admin → Settings → Webhooks → add URL + event `order.placed`

### Genero (Bisley New Wave API)
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/genero/submit/:orderId` | Submit all line items for an order to Genero |
| `POST` | `/api/genero/poll` | Poll all open lines for updated `status` + `Est_delivery` |
| `GET` | `/api/genero/lines/:orderId` | Current Genero status per line on an order |
| `GET` | `/api/genero/config` | Show configured API URL and account (no secrets) |

**Genero API spec (Bisley NW):**  
POST: `account` (req), `order_id?`, `order_ref?`, `name?`, `sku` (req, e.g. `AOC4-av4`), `quantity` (req)  
Returns: `status`, `bisley_order`, `Est_delivery` — poll periodically as delivery date updates.

### Supplier Orders
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/orders` | List orders with filters |
| `POST` | `/api/orders` | Create manual order |
| `POST` | `/api/orders/from-nw` | Auto-create draft order from NW stocking programme |
| `GET` | `/api/orders/:id` | Order + line items |
| `PATCH` | `/api/orders/:id` | Update (status, notes, expected_delivery) |
| `DELETE` | `/api/orders/:id` | Delete draft order |

### SKU Mappings
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sku-mappings` | List with filters + thumbnail join from wms_products |
| `GET` | `/api/sku-mappings/stats` | Fast status counts (total/validated/assumed/unmapped) |
| `GET` | `/api/sku-mappings/unmapped` | Unmapped items only |
| `PATCH` | `/api/sku-mappings/:id` | Update (medusa_sku, status, notes) |
| `POST` | `/api/sku-mappings/:id/validate` | Mark as VALIDATED |
| `POST` | `/api/sku-mappings/validate-assumed` | Bulk validate all ASSUMED mappings |
| `POST` | `/api/sku-mappings/auto-match` | Fuzzy match against wms_products |
| `POST` | `/api/sku-mappings/import` | Bulk import NW stocking items |

### Check-in / Receiving
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/checkin/lookup?q=` | Resolve barcode/NW code → product info |
| `POST` | `/api/checkin/sessions` | Start a check-in session |
| `POST` | `/api/checkin/sessions/:id/scan` | Add scanned item |
| `POST` | `/api/checkin/sessions/:id/compare` | Auto-compare vs order |
| `POST` | `/api/checkin/sessions/:id/complete` | Finalise session |
| `GET` | `/api/receiving/queue` | Items awaiting bay assignment |
| `PATCH` | `/api/receiving/queue/:id/assign` | Assign item to bay |
| `POST` | `/api/receiving/queue/:id/stock` | Mark as stocked → warehouse_inventory |
| `GET` | `/api/receiving/locations` | All warehouse bays |
| `POST` | `/api/receiving/locations/generate` | Bulk-generate bays (rows × bins) |

### Inventory Sync (WMS → Medusa)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/inventory/pre-sync` | Compare WMS qty vs Medusa |
| `POST` | `/api/inventory/sync` | Push WMS quantities to Medusa |
| `POST` | `/api/inventory/seed-from-medusa` | Seed WMS inventory from current Medusa stock |

### Reports
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/reports` | Full summary: movements, orders, Genero, stock health, SKU coverage |
| `GET` | `/api/reports/movements` | Paginated warehouse movement log |

### Settings
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/settings/field-mappings` | Medusa→WMS + WMS→Genero field mappings |
| `POST` / `PUT` / `DELETE` | `/api/settings/field-mappings/:id` | CRUD |

### Pick Lists
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/pick-lists` | List active pick lists |
| `GET` | `/api/pick-lists/:pickListId` | Pick list detail with items and package summary |
| `GET` | `/api/pick-lists/:pickListId/fulfilment-plan` | Courier-agnostic shipping plan, package plan and reference data |
| `PATCH` | `/api/pick-lists/:pickListId/fulfilment-plan` | Save courier choice, packaging costs, parcel count and package records |
| `PATCH` | `/api/pick-lists/:pickListId/packing/start` | Move a picked order into packing |
| `PATCH` | `/api/pick-lists/:pickListId/packing/complete` | Mark packing complete and store packaging totals |
| `PATCH` | `/api/pick-lists/:pickListId/label-printed` | Mark labels printed before dispatch |
| `POST` | `/api/pick-lists/:pickListId/packages/:packageNumber/ups-label` | Generate a UPS label for a saved package |
| `PATCH` | `/api/pick-lists/:pickListId/dispatch` | Final outbound stock decrement and dispatch completion |

### Fulfilment Data Model
- `shipping_services` stores courier/service options without binding the system to one carrier API.
- `packaging_profiles` stores reusable cartons, pallets and their default costs.
- `packaging_checklist_templates` stores repeatable packing checklists.
- `product_fulfillment_profiles` stores SKU-level fulfilment tags, packaging defaults and service hints.
- `pick_list_packages` stores real packages, tracking numbers, label state and cost per package.

### Scanning
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/scanning/scan` | Parse barcode → product info |
| `POST` | `/api/scanning/inventory/receive` | Log received stock |
| `GET` | `/api/scanning/inventory/location/:code` | View bin contents |
| `GET` | `/api/scanning/inventory/search/:sku` | Find SKU across all bays |

### Reorder Rules & Pending Reorders
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/reorder-rules` | List rules with current WMS stock + pending reorder join |
| `POST` | `/api/reorder-rules/init` | Generate rules from an order's line items (order_qty/2 = monthly demand) |
| `PUT` | `/api/reorder-rules/:id` | Update a rule (reorder_point, reorder_qty, monthly_demand, lead_time_weeks) |
| `POST` | `/api/reorder-rules/check` | Run threshold check now, create pending reorders for any SKU below reorder_point |
| `GET` | `/api/pending-reorders` | List pending reorders awaiting approval |
| `POST` | `/api/pending-reorders/:id/approve` | Approve — adds to (or creates) a supplier order |
| `POST` | `/api/pending-reorders/:id/delay` | Snooze a pending reorder |
| `POST` | `/api/pending-reorders/:id/cancel` | Dismiss a pending reorder |
| `POST` | `/api/pending-reorders/bulk-approve` | Approve all pending reorders in one action |

### Error Log
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/error-log` | Paginated error/warning/info list with source, severity, resolved filters |
| `GET` | `/api/error-log/stats` | Open counts by source + severity |
| `PATCH` | `/api/error-log/:id/resolve` | Mark a single entry resolved |
| `POST` | `/api/error-log/resolve-all` | Bulk-resolve matching a filter |
| `DELETE` | `/api/error-log/old` | Purge INFO entries older than 7 days |
| `POST` | `/api/error-log/check-discrepancies` | Run the WMS-vs-Medusa quantity check now (also runs every 30 min in production) |

`check-discrepancies` compares `SUM(warehouse_inventory.quantity)` per SKU against Medusa's `stocked_quantity`. Mismatches are logged as `WARNING` entries (source `DISCREPANCY_CHECK`); an entry auto-resolves once the SKU's quantities agree again, and an unchanged open mismatch is never re-logged.

### Notifications
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/notifications` | Paginated notification list |
| `GET` | `/api/notifications/count` | Unread count (polled by the dashboard header) |
| `POST` | `/api/notifications/read-all` | Mark all as read |

### Deliveries
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/deliveries` | Incoming dispatch batches detected from Genero polling |

---

## Database Schema (33 tables)

### Product Data
- `wms_products` — local Medusa cache
- `barcode_mappings` — supercode / SKU+colour lookups for scanning

### NW Stocking Programme
- `sku_mappings` — NW code ↔ Medusa SKU ↔ Genero code
- `nw_stocking_items` — line items from NW stocking spreadsheet

### Supplier Orders & Genero
- `supplier_orders` — purchase orders sent to New Wave (status, supplier, submitted/dispatched/received timestamps)
- `order_line_items` — individual SKU quantities per order
- `supplier_order_items` — legacy per-order-item table, superseded by `order_line_items`; not currently queried
- `genero_order_lines` — per-line Genero responses (`account`, `sku`, `bisley_order`, `genero_status`, `Est_delivery`)
- `genero_dispatch_notes` — incoming dispatch notifications
- `genero_deliveries` — incoming delivery batches detected from Genero polling
- `inventory_thresholds` — reorder trigger levels
- `reorder_rules` — per-SKU reorder point / reorder qty / monthly demand / lead time
- `pending_reorders` — reorder suggestions awaiting approval

### Warehouse Operations
- `warehouse_locations` — bays and bins
- `warehouse_inventory` — physical stock by bay (functional UNIQUE on `COALESCE(colour_code,'')`)
- `warehouse_movements` — full audit trail (RECEIVE, PICK, ADJUST, RETURN)
- `warehouse_users` — staff accounts

### Check-in & Receiving
- `checkin_sessions` — receiving sessions
- `checkin_items` — scanned items per session
- `checkin_discrepancies` — SHORT, OVERAGE, MISSING, UNEXPECTED flags
- `requires_location_queue` — items checked in, awaiting bay assignment

### Fulfilment
- `pick_lists` — customer order fulfillment jobs (auto-created via webhook); `is_sandbox` flag for safe test picking
- `pick_list_items` — individual line items; `is_sandbox` flag mirrors the parent list
- `pick_list_packages` — real packages, tracking numbers, label state and cost per package
- `pick_list_package_items` — SKU/qty breakdown per package
- `shipping_services` — courier/service options, decoupled from a single carrier API
- `packaging_profiles` — reusable cartons, pallets and their default costs
- `packaging_checklist_templates` — repeatable packing checklists
- `product_fulfillment_profiles` — SKU-level fulfilment tags, packaging defaults and service hints

### Config, Audit & Monitoring
- `field_mappings` — Medusa→WMS + WMS→Genero field config
- `audit_log` — security / compliance log
- `wms_error_log` — centralised error/warning/info log surfaced on the Error Log page
- `wms_notifications` — dashboard notification feed

---

## Key Workflows

```
NW Stocking → SKU Mapping → Supplier Order → Submit to Genero
→ Poll for delivery → Delivery arrives → Check-in → Bay Assignment
→ Pre-Sync → Sync to Medusa

Customer orders → Webhook → Pick List → Mobile scan to pick → Pack → Label → Dispatch

Stock depletes below reorder_point → Pending Reorder created → Approve → Supplier Order
```

---

## Genero Integration

Runs in **simulation mode** by default (bisley_order=499443, status=Open).  
To go live, set two Railway environment variables:
```
GENERO_API_URL=https://<bisley-nw-endpoint>/api/orders
GENERO_ACCOUNT_NO=NW123
```
No code changes required.

---

## Scripts

```bash
npm run dev          # development server (tsx watch)
npm run start        # production start (tsx src/server.ts)
npm run db:migrate   # run schema migrations (safe to re-run)
npm run db:seed      # seed test data

# Run from workspace root:
node scripts/create-first-nw-order.mjs   # creates ORD-NW-YYYYMMDD-001 from NW stocking vs Medusa inventory
```

