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
| `GENERO_API_URL` | ⚠️ | Bisley New Wave API endpoint. When unset the integration runs in **simulation mode** |
| `GENERO_ACCOUNT_NO` | ⚠️ | NW account number (e.g. `NW123`) |
| `PORT` | — | Server port (Railway sets this; defaults to 3001) |
| `NODE_ENV` | — | `production` enables strict JWT validation |

---

## API Reference

All endpoints require `Authorization: Bearer <jwt>`.  
Auth accepts any valid JWT or demo token (payload: `{ sub, email, role }`).

### Dashboard
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/dashboard` | Live stats for all WMS entities (products, orders, check-in, etc.) |

### Products (Medusa Sync)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/products` | Live fetch from Medusa (5-min memory cache) |
| `GET` | `/api/products/wms-cache` | Read from local `wms_products` table |
| `POST` | `/api/products/sync` | Pull all Medusa products into WMS DB (async background job) |
| `GET` | `/api/products/sync/status` | Poll sync job status and result |
| `GET` | `/api/products/:id` | Single product from memory cache |

### Genero (Bisley New Wave API)
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/genero/submit/:orderId` | Submit all line items for a WMS order to Genero |
| `POST` | `/api/genero/poll` | Re-poll all open lines for updated status/Est_delivery |
| `GET` | `/api/genero/lines/:orderId` | Current Genero status for all lines on an order |
| `GET` | `/api/genero/config` | Show configured API URL and account (no secrets) |

**Genero field spec (from Bisley NW):**

POST payload: `account` (required), `order_id?`, `order_ref?`, `name?`, `sku` (required), `quantity` (required)  
Returns: `status`, `bisley_order`, `Est_delivery` — these update over time and should be polled regularly.

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
| `GET` | `/api/sku-mappings` | List all mappings with filters + search |
| `GET` | `/api/sku-mappings/unmapped` | Unmapped items only |
| `GET` | `/api/sku-mappings/conflicts` | Conflict detection |
| `PATCH` | `/api/sku-mappings/:id` | Update (medusa_sku, status, notes) |
| `POST` | `/api/sku-mappings/:id/validate` | Mark as VALIDATED |
| `POST` | `/api/sku-mappings/auto-match` | Run fuzzy matching against wms_products |
| `POST` | `/api/sku-mappings/import` | Bulk import NW stocking items |

### Check-in (Receiving)
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/checkin/sessions` | Start a check-in session |
| `GET` | `/api/checkin/sessions` | List sessions |
| `POST` | `/api/checkin/sessions/:id/scan` | Scan item into session |
| `POST` | `/api/checkin/sessions/:id/compare` | Auto-compare vs order |
| `POST` | `/api/checkin/sessions/:id/complete` | Complete session |

### Bay Assignment (Receiving Queue)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/receiving/queue` | Items awaiting bay assignment |
| `PATCH` | `/api/receiving/queue/:id/assign` | Assign item to a bay |
| `POST` | `/api/receiving/queue/:id/stock` | Mark as stocked (move to warehouse_inventory) |

### Inventory Sync (WMS → Medusa)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/inventory/pre-sync` | Compare WMS qty vs Medusa (Medusa is source of truth) |
| `POST` | `/api/inventory/sync` | Push WMS quantities to Medusa |
| `GET` | `/api/inventory/pre-sync?refresh=true` | Bust 10-min Medusa inventory cache |

### Settings
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/settings/field-mappings` | All field mappings (Medusa→WMS and WMS→Genero) grouped by direction |
| `POST` | `/api/settings/field-mappings` | Create mapping |
| `PUT` | `/api/settings/field-mappings/:id` | Update mapping |
| `DELETE` | `/api/settings/field-mappings/:id` | Delete mapping |

### Scanning
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/scanning/scan` | Parse barcode (supercode or plain SKU) |
| `POST` | `/api/scanning/inventory/receive` | Log received stock |
| `GET` | `/api/scanning/inventory/location/:code` | View bin contents |
| `GET` | `/api/scanning/inventory/search/:sku` | Find SKU across all locations |

### Pick Lists
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/pick-lists` | List active pick lists |
| `GET` | `/api/pick-lists/:id` | Detail with items |
| `POST` | `/api/pick-lists` | Create pick list |
| `PATCH` | `/api/pick-lists/:id/items/:itemId/pick` | Mark item as picked |
| `PATCH` | `/api/pick-lists/:id/complete` | Complete pick list |

---

## Database Schema (22 tables)

### Product Sync
- `wms_products` — local Medusa cache (product + variant + kit data, refreshed via `/sync`)
- `barcode_mappings` — supercode / SKU+colour lookups for scanning

### NW Stocking Programme
- `sku_mappings` — maps NW product codes → Medusa SKUs → Genero codes
- `nw_stocking_items` — line items from the NW stocking spreadsheet

### Supplier Orders & Genero
- `supplier_orders` — purchase orders sent to New Wave
- `order_line_items` — individual SKU quantities per order
- `genero_order_lines` — per-line Genero API responses (`bisley_order`, `status`, `Est_delivery`)
- `genero_dispatch_notes` — incoming dispatch notifications
- `inventory_thresholds` — reorder trigger levels

### Warehouse Operations
- `warehouse_locations` — bays and bins
- `warehouse_inventory` — physical stock by location
- `warehouse_movements` — audit trail (receive, pick, adjust)
- `warehouse_users` — staff accounts

### Check-in & Receiving
- `checkin_sessions` — receiving sessions
- `checkin_items` — scanned items per session
- `checkin_discrepancies` — auto-flagged mismatches vs order
- `requires_location_queue` — items checked in, awaiting bay assignment

### Pick & Fulfill
- `pick_lists` — customer order fulfillment jobs
- `pick_list_items` — individual line items

### Configuration
- `field_mappings` — Medusa→WMS and WMS→Genero field mapping config

### Audit
- `audit_log` — security / compliance log

---

## Workflow

```
NW Stocking Programme → SKU Mapping → Create Supplier Order
        ↓
Submit to Genero API (POST /api/genero/submit/:orderId)
        ↓
Poll for updates (POST /api/genero/poll) — status + Est_delivery
        ↓
Check-in (scan items vs order) → Discrepancy flags
        ↓
Bay Assignment (requires_location_queue → warehouse_inventory)
        ↓
Pre-Sync Comparison (WMS vs Medusa)
        ↓
Sync to Medusa (POST /api/inventory/sync)
```

---

## Genero Integration

The Genero integration is in **simulation mode** by default (no real API calls).  
To go live, set two Railway env vars:

```
GENERO_API_URL=https://<bisley-nw-endpoint>/api/orders
GENERO_ACCOUNT_NO=NW123
```

No code changes required. On next deploy, all Genero submit/poll calls will hit the live API.

---

## Scripts

```bash
npm run dev          # development server (tsx watch)
npm run start        # production start (tsx src/server.ts)
npm run db:migrate   # run schema migrations (safe to re-run)
npm run db:seed      # seed test data
```
