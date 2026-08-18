# Warehouse Management System (WMS) Backend

Custom warehouse management system for Bisley Shop, designed to work in isolation while preparing for seamless integration with Medusa (e-commerce) and Genero (supplier order management).

## 🎯 Overview

This is a **Node.js/Express/PostgreSQL** application that manages:

- **Barcode Scanning** — USB scanner input, supercode parsing (SKU + colour)
- **Supplier Intake** — Log received stock, assign to bay/bin locations
- **Inventory Tracking** — Real-time stock levels by location
- **Pick Lists** — Orders to fulfill, pick/pack/ship workflow
- **Audit Logging** — Full history of all warehouse activities

Hosted on **Railway.app** (£20/mo) with PostgreSQL, designed for Mark to operate from the warehouse.

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd apps/warehouse-backend
npm install
```

### 2. Set Up Environment

```bash
cp .env.example .env.local
# Edit .env.local with your settings (DATABASE_URL, JWT_SECRET, etc)
```

### 3. Run Database Migrations

```bash
npm run db:migrate
```

This creates all 13 warehouse tables:
- `warehouse_locations` (bays/bins)
- `warehouse_inventory` (stock levels by location)
- `barcode_mappings` (supercode lookup)
- `pick_lists` (orders to pick)
- `warehouse_movements` (audit trail)
- `warehouse_users` (staff)
- `supplier_orders` (replenishment requests to Genero)
- `audit_log` (security/compliance)
- + support tables

### 4. Start Development Server

```bash
npm run dev
```

Server runs on `http://localhost:3001`  
Health check: `http://localhost:3001/health`

---

## 📋 API Endpoints

### Barcode Scanning

#### `POST /api/scanning/scan`
Process a barcode input (USB scanner or manual entry)

```bash
curl -X POST http://localhost:3001/api/scanning/scan \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"barcode": "H2910NL-BLK"}'
```

**Response:**
```json
{
  "rawInput": "H2910NL-BLK",
  "productSku": "H2910NL",
  "colourCode": "BLK",
  "colourName": "Black",
  "isValid": true
}
```

**Barcode Format:**
- Supercode: `SKU-COLOURCODE` (e.g., `H2910NL-BLK`)
- Plain SKU: `SKU` (e.g., `H2910NL`)
- If plain SKU, Mark will be prompted to confirm colour via UI

---

### Inventory Management

#### `POST /api/scanning/inventory/receive`
Log stock received from supplier

```bash
curl -X POST http://localhost:3001/api/scanning/inventory/receive \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "locationCode": "A1",
    "productSku": "H2910NL",
    "colourCode": "BLK",
    "quantity": 10,
    "notes": "Delivery from supplier, box damaged but contents OK"
  }'
```

**Response:**
```json
{
  "success": true,
  "inventory": {
    "id": "uuid",
    "location_id": "uuid",
    "product_sku": "H2910NL",
    "colour_code": "BLK",
    "quantity": 10,
    "quantity_available": 10
  },
  "message": "Received 10 units of H2910NL at A1"
}
```

#### `GET /api/scanning/inventory/location/:locationCode`
View all stock at a specific bin

```bash
curl -X GET http://localhost:3001/api/scanning/inventory/location/A1 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### `GET /api/scanning/inventory/search/:productSku`
Find all locations where a SKU is stored

```bash
curl -X GET http://localhost:3001/api/scanning/inventory/search/H2910NL \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

### Pick Lists

#### `GET /api/pick-lists`
List all active pick lists

```bash
curl -X GET "http://localhost:3001/api/pick-lists?status=PENDING,IN_PROGRESS" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### `GET /api/pick-lists/:pickListId`
Get detailed view of a pick list with all items

#### `POST /api/pick-lists`
Create a new pick list from a Medusa order

```bash
curl -X POST http://localhost:3001/api/pick-lists \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "medusaOrderId": "order_abc123",
    "notes": "Customer order from web"
  }'
```

#### `POST /api/pick-lists/:pickListId/items`
Add a line item to a pick list

```bash
curl -X POST http://localhost:3001/api/pick-lists/uuid/items \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "lineNumber": 1,
    "productSku": "H2910NL",
    "colourCode": "BLK",
    "quantityRequired": 5
  }'
```

#### `PATCH /api/pick-lists/:pickListId/items/:itemId/pick`
Mark an item as picked (scan barcode to confirm)

```bash
curl -X PATCH http://localhost:3001/api/pick-lists/uuid/items/uuid/pick \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "quantityPicked": 5,
    "pickedFromLocationCode": "A1",
    "notes": "All units picked successfully"
  }'
```

#### `PATCH /api/pick-lists/:pickListId/complete`
Mark a pick list as fully completed

```bash
curl -X PATCH http://localhost:3001/api/pick-lists/uuid/complete \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"notes": "Ready for packing"}'
```

---

## 🔐 Authentication

All endpoints require a **JWT Bearer token** in the Authorization header.

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Token should include:**
```json
{
  "id": "user_123",
  "email": "mark@bisley.com",
  "role": "PICKER"
}
```

**Getting a token:**
- Mark logs into Medusa Admin
- Medusa issues a JWT
- Mark uses that JWT for WMS API calls

(Integration with Medusa auth is a future enhancement)

---

## 📊 Database Schema

### warehouse_locations
Bays and bins in the warehouse

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| bay_code | VARCHAR | Bay identifier (e.g., "A") |
| bin_code | VARCHAR | Bin identifier (e.g., "1") |
| location_code | VARCHAR | Full location (e.g., "A1") UNIQUE |
| description | TEXT | Bin purpose/notes |
| max_weight_kg | DECIMAL | Weight capacity |
| is_active | BOOLEAN | Active status |

### warehouse_inventory
Current stock at each location

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| location_id | UUID | References warehouse_locations |
| product_sku | VARCHAR | Product code |
| colour_code | VARCHAR | Colour variant |
| quantity | INT | Total units in bin |
| quantity_reserved | INT | Units reserved for pick lists |
| quantity_available | INT | GENERATED: quantity - reserved |

### barcode_mappings
Supercode → product lookups

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| barcode | VARCHAR | Supercode (SKU-COLOUR) UNIQUE |
| product_sku | VARCHAR | SKU |
| colour_code | VARCHAR | Colour code |
| colour_name | VARCHAR | Full colour name |
| product_name | VARCHAR | Product title |
| medusa_product_id | VARCHAR | Medusa ID (for sync) |
| medusa_variant_id | VARCHAR | Medusa variant ID (for sync) |

### pick_lists
Order-level picking instructions

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| medusa_order_id | VARCHAR | Customer order ID UNIQUE |
| pick_list_number | VARCHAR | Internal pick list # (e.g., "PL-20260818-0001") |
| status | VARCHAR | PENDING → IN_PROGRESS → PICKED → PACKED → SHIPPED |
| created_at | TIMESTAMP | When created |
| completed_at | TIMESTAMP | When picking finished |

### pick_list_items
Individual line items in a pick list

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| pick_list_id | UUID | References pick_lists |
| line_number | INT | Sequential line (1, 2, 3...) |
| product_sku | VARCHAR | Product code |
| colour_code | VARCHAR | Colour variant |
| quantity_required | INT | How many to pick |
| quantity_picked | INT | How many picked |
| picked_from_location_id | UUID | Bin where picked from |
| status | VARCHAR | PENDING → PICKING → PICKED → SHORT |

### warehouse_movements
Complete audit trail of all activity

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| movement_type | VARCHAR | RECEIVE, PICK, RETURN, ADJUST, RECOUNT |
| location_id | UUID | Bin involved |
| product_sku | VARCHAR | Product code |
| quantity | INT | Units moved |
| performed_by | UUID | User who did it |
| notes | TEXT | Reason/notes |
| movement_date | TIMESTAMP | When it happened |

### warehouse_users, supplier_orders, audit_log
(See full schema in `src/db/schema.ts`)

---

## 🎬 Workflow: Mark Receives Stock

1. **Mark receives box of stock** (e.g., 10x H2910NL-BLK from supplier)
2. **Opens warehouse app** on his tablet/computer
3. **Scans box barcode** via USB scanner
   - API validates supercode: `H2910NL-BLK` ✓
4. **Assigns to location** (e.g., "A1")
5. **Confirms quantity** (10 units)
6. **App updates inventory:**
   - warehouse_inventory: A1 now has 10x H2910NL-BLK
   - warehouse_movements: logs RECEIVE event
   - audit_log: records who, when, what
7. ✅ Stock now available for picking

---

## 🎬 Workflow: Mark Picks an Order

1. **Pick list created** (from Medusa order)
   - medusa_order_id: order_abc123
   - Pick list number: PL-20260818-0001
   - Items: [1x H2910NL-BLK, 2x H2910NL-RED]
2. **Mark opens "Active Pick Lists"** dashboard
3. **Taps "Start Picking"** on PL-20260818-0001
4. **For each item:**
   - App says: "Pick 1x H2910NL-BLK from location A1"
   - Mark walks to A1, scans the product
   - Mark confirms: "1 unit picked"
   - App updates: quantity_picked = 1, status = PICKED
   - Inventory: quantity_reserved increases
5. **All items picked?** Mark taps "Complete Pick List"
6. ✅ Order ready for packing

---

## 🔗 Future: Medusa Integration

When ready, the WMS will:

1. **Listen to Medusa webhooks** → Order created
2. **Auto-create pick lists** from new orders
3. **Sync inventory levels** back to Medusa in real-time
4. **Prevent overselling** if warehouse stock drops

(Implementation: see docs/WMS-SPECIFICATION.md)

---

## 🔗 Future: Genero Integration

When ready, the WMS will:

1. **Monitor inventory thresholds**
2. **Push replenishment requests** to intermediary table
3. **Track supplier order status** from Genero
4. **Update forecast** when stock arrives

(Implementation: see docs/GENERO-INTERMEDIARY-TABLE.md)

---

## 🧪 Testing

### Manual Test: Barcode Scan

```bash
# 1. Get a JWT token (from Medusa Admin)
TOKEN="your_jwt_token"

# 2. Test valid supercode
curl -X POST http://localhost:3001/api/scanning/scan \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"barcode": "H2910NL-BLK"}'

# Expected: { "isValid": true, "productSku": "H2910NL", "colourCode": "BLK", ... }

# 3. Test invalid barcode
curl -X POST http://localhost:3001/api/scanning/scan \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"barcode": "INVALID"}'

# Expected: { "isValid": false, "error": "Invalid barcode format..." }
```

### Manual Test: Receive Stock

```bash
TOKEN="your_jwt_token"

curl -X POST http://localhost:3001/api/scanning/inventory/receive \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "locationCode": "A1",
    "productSku": "H2910NL",
    "colourCode": "BLK",
    "quantity": 5
  }'

# Expected: { "success": true, "inventory": { ... } }
```

---

## 🛠️ Deployment to Railway

### 1. Connect GitHub
```bash
git push origin main
```

### 2. Railway Dashboard
- New Project → GitHub → Select repo
- Railway auto-detects Node.js
- Create PostgreSQL add-on
- Set environment variables in Railway dashboard

### 3. Deploy
```bash
git push  # Railway auto-deploys
```

Your WMS will be live at: `https://warehouse-wms.railway.app`

---

## 📝 Environment Variables

| Variable | Example | Notes |
|----------|---------|-------|
| DATABASE_URL | postgresql://... | Required |
| PORT | 3001 | Default |
| NODE_ENV | production | dev/production |
| JWT_SECRET | your_secret_key | Change in production |
| MEDUSA_API_BASE_URL | https://... | For future sync |
| MEDUSA_API_KEY | your_key | For future sync |
| GENERO_API_BASE_URL | https://... | For future sync |
| GENERO_API_KEY | your_key | For future sync |

---

## 📚 Further Reading

- [WMS Specification](../../docs/WMS-SPECIFICATION.md) — Full technical blueprint
- [Genero Integration](../../docs/GENERO-INTERMEDIARY-TABLE.md) — Supplier order sync
- [Barcode Module](./src/modules/scanning/barcode.ts) — Supercode parser
- [Pick List API](./src/api/routes/pick-lists.ts) — Picking workflows

---

## 👤 Author

Built for Mark @ Bisley Shop Warehouse  
Questions? Check the docs or open an issue.
