# Warehouse WMS Setup Guide

Complete setup guide for deploying the Warehouse Management System locally and to production (Railway).

---

## 📋 Prerequisites

- Node.js 18+
- PostgreSQL 14+ (local or Railway)
- npm or yarn
- JWT token from Medusa Admin (for auth)

---

## 🏠 Local Development Setup

### 1. Install Dependencies

```bash
cd apps/warehouse-backend
npm install
```

### 2. Create Environment File

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```env
# Server
PORT=3001
NODE_ENV=development

# Database (use local PostgreSQL for development)
DATABASE_URL=postgresql://postgres:password@localhost:5432/warehouse_db

# JWT
JWT_SECRET=your_local_test_secret

# Medusa (future integration)
MEDUSA_API_BASE_URL=http://localhost:9000
MEDUSA_API_KEY=your_test_key

# Genero (future integration)
GENERO_API_BASE_URL=https://genero.example.com
GENERO_API_KEY=your_test_key
```

### 3. Create Local PostgreSQL Database

```bash
# On Windows (PowerShell):
createdb warehouse_db

# Or using psql:
psql -U postgres -c "CREATE DATABASE warehouse_db;"
```

### 4. Run Migrations

```bash
npm run db:migrate
```

Output:
```
✓ Connected to PostgreSQL
✓ Warehouse schema created/verified

📋 Created tables:
   - audit_log
   - barcode_mappings
   - pick_list_items
   - pick_lists
   - supplier_order_items
   - supplier_orders
   - warehouse_inventory
   - warehouse_locations
   - warehouse_movements
   - warehouse_users

✅ Migrations completed successfully
```

### 5. Seed Test Data (Optional)

```bash
npm run db:seed
```

Output:
```
🌱 Seeding database...

🗑️  Clearing existing data...

📍 Creating warehouse locations...
✓ Created 20 locations (A1-A10, B1-B10)

🏷️  Creating barcode mappings...
✓ Created 9 barcode mappings

👤 Creating warehouse users...
✓ Created 3 users

📦 Populating initial inventory...
✓ Created 15 inventory records

✅ Seed completed successfully!

📊 Summary:
   - Locations: 20 (bays A-B, bins 1-10)
   - Barcode mappings: 9
   - Users: 3
   - Inventory records: 15

👤 Test users:
   - mark@bisley.com (role: PICKER)
   - admin@bisley.com (role: ADMIN)
   - manager@bisley.com (role: MANAGER)
```

### 6. Start Development Server

```bash
npm run dev
```

Output:
```
🏭 Warehouse Management System
Environment: development
✓ Database pool initialized
✓ Database connection verified
✓ Server running on port 3001
  Health: http://localhost:3001/health
  API: http://localhost:3001/api
```

---

## 🧪 Test the API Locally

### 1. Get a JWT Token

For local development, generate a test token:

```bash
# Create a test JWT (use any user ID, the secret must match JWT_SECRET in .env)
node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { id: 'user_mark', email: 'mark@bisley.com', role: 'PICKER' },
  'your_local_test_secret',
  { algorithm: 'HS256', expiresIn: '24h' }
);
console.log('Bearer ' + token);
"
```

Save the token as `TOKEN`:

```bash
TOKEN="Bearer eyJhbGc..."
```

### 2. Test Barcode Scan

```bash
curl -X POST http://localhost:3001/api/scanning/scan \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"barcode": "H2910NL-BLK"}'
```

Expected response:
```json
{
  "rawInput": "H2910NL-BLK",
  "productSku": "H2910NL",
  "colourCode": "BLK",
  "colourName": "Black",
  "isValid": true
}
```

### 3. Test Inventory Receive

```bash
curl -X POST http://localhost:3001/api/scanning/inventory/receive \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "locationCode": "A1",
    "productSku": "H2910NL",
    "colourCode": "BLK",
    "quantity": 5,
    "notes": "Test receipt"
  }'
```

### 4. Test Pick Lists

```bash
# Create pick list
curl -X POST http://localhost:3001/api/pick-lists \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "medusaOrderId": "order_test_001",
    "notes": "Test pick list"
  }'

# Get active pick lists
curl -X GET "http://localhost:3001/api/pick-lists?status=PENDING" \
  -H "Authorization: $TOKEN"
```

---

## 🚀 Deploy to Railway

### 1. Create Railway Account

Go to [railway.app](https://railway.app) and sign up with GitHub.

### 2. Create PostgreSQL Service

In Railway dashboard:
1. New Project
2. Add PostgreSQL
3. Copy connection string to notes

### 3. Push Code to GitHub

```bash
git add apps/warehouse-backend/
git commit -m "feat: warehouse management system backend"
git push origin main
```

### 4. Deploy on Railway

1. Railway dashboard → New Project
2. Select your GitHub repo
3. Select `apps/warehouse-backend` directory
4. Railway auto-creates Node.js service
5. Set environment variables:
   - `DATABASE_URL` → PostgreSQL connection string
   - `PORT` → 3001
   - `NODE_ENV` → production
   - `JWT_SECRET` → strong random value
   - `MEDUSA_API_BASE_URL` → https://bisley-shop.medusajs.app
   - `MEDUSA_API_KEY` → your Medusa admin key

### 5. Run Migrations on Railway

In Railway terminal:

```bash
npm run db:migrate
```

### 6. Access Your WMS

Railway will provide a URL like: `https://warehouse-wms.railway.app`

Test health:
```bash
curl https://warehouse-wms.railway.app/health
```

---

## 🎯 Next Steps

### Phase 1: Mark's Barcode Scanning (Isolated)
✅ Done! Mark can now:
- Scan barcodes (USB scanner)
- Receive stock into warehouse
- View inventory by location
- Create pick lists
- Pick orders

### Phase 2: Medusa Integration (In Progress)
Tasks:
- [ ] Create Medusa webhook listener (new order → auto pick list)
- [ ] Sync real-time inventory back to Medusa
- [ ] Prevent overselling if warehouse stock drops
- [ ] Update order status (picked → ready to ship)

### Phase 3: Genero Integration (Pending Bisley Data)
Tasks:
- [ ] Receive intermediary table schema from Bisley DevOps
- [ ] Build inventory threshold monitor
- [ ] Push replenishment requests to intermediary table
- [ ] Poll Genero for status updates
- [ ] Update forecast when stock arrives

---

## 📝 File Structure

```
apps/warehouse-backend/
├── src/
│   ├── server.ts                 # Main app entry
│   ├── db/
│   │   ├── index.ts              # Database pool
│   │   ├── schema.ts             # Table definitions
│   │   ├── migrate.ts            # Run migrations
│   │   └── seed.ts               # Seed test data
│   ├── middleware/
│   │   └── auth.ts               # JWT validation
│   ├── modules/
│   │   └── scanning/
│   │       └── barcode.ts        # Barcode parser
│   └── api/
│       └── routes/
│           ├── scanning.ts       # Scan/intake endpoints
│           └── pick-lists.ts     # Pick list endpoints
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

---

## 🐛 Troubleshooting

### Database Connection Error

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Fix:** Ensure PostgreSQL is running:

```bash
# Windows (PowerShell)
Get-Service postgresql-x64-* | Start-Service

# macOS
brew services start postgresql

# Linux
sudo service postgresql start
```

### JWT Token Invalid

```
Error: Invalid or expired token
```

**Fix:** Ensure `JWT_SECRET` in `.env.local` matches the token signing secret.

### Migration Failed

```
Error: relation "warehouse_locations" already exists
```

**Fix:** This is expected on re-runs. Migrations use `IF NOT EXISTS`. Safe to retry.

### Port Already in Use

```
Error: listen EADDRINUSE :::3001
```

**Fix:** Change PORT in `.env.local` or kill the process:

```bash
# Kill process on port 3001
lsof -ti:3001 | xargs kill -9
```

---

## 📚 Additional Resources

- [README.md](./README.md) — Full API documentation
- [WMS Specification](../../docs/WMS-SPECIFICATION.md) — Architecture & design
- [Genero Integration](../../docs/GENERO-INTERMEDIARY-TABLE.md) — Supplier orders
- [Barcode Module](./src/modules/scanning/barcode.ts) — Supercode parser
- [Railway Docs](https://docs.railway.app/) — Deployment help

---

## 🤝 Support

Questions about the WMS setup?
- Check the [README.md](./README.md) for detailed API docs
- Review [src/api/routes/](./src/api/routes/) for endpoint implementations
- Check test section above for example requests

