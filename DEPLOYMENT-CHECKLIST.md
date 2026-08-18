# Warehouse WMS Deployment Checklist

Complete pre-deployment checklist for launching the warehouse management system to production (Railway.app).

---

## 📋 Pre-Deployment (Code Ready)

### Code Review
- [ ] All TypeScript compiles without errors
- [ ] All endpoints tested locally with JWT token
- [ ] `.env.example` has all required variables documented
- [ ] No hardcoded secrets in code (check git diff)
- [ ] No `console.log()` debug statements in routes
- [ ] Error messages are user-friendly, not exposing internal details

### Documentation
- [ ] README.md complete with all API endpoints
- [ ] SETUP.md has local & production instructions
- [ ] MARK-QUICK-START.md ready for warehouse operator
- [ ] Comments in code explain complex logic

### Testing
- [ ] `npm run build` succeeds (TypeScript compiles)
- [ ] Barcode parser works with sample supercodes
- [ ] Inventory receive logic tested
- [ ] Pick list creation & completion tested
- [ ] Auth middleware rejects invalid tokens

---

## 🚀 Railway Deployment Checklist

### Railway Account & Project Setup
- [ ] Railway.app account created
- [ ] GitHub connected to Railway
- [ ] New project created in Railway
- [ ] Repository selected (Bisley Shop monorepo)

### PostgreSQL Database
- [ ] PostgreSQL add-on created in Railway
- [ ] Test connection successful
- [ ] Backup strategy confirmed (Railway auto-backups daily)
- [ ] Connection string saved & verified

### Environment Variables (Set in Railway Dashboard)

**Required Variables:**
- [ ] `DATABASE_URL` = PostgreSQL connection string
- [ ] `NODE_ENV` = production
- [ ] `PORT` = 3001 (or Railway-assigned)
- [ ] `JWT_SECRET` = strong random value (generate: `openssl rand -base64 32`)

**Optional Variables:**
- [ ] `MEDUSA_API_BASE_URL` = https://bisley-shop.medusajs.app
- [ ] `MEDUSA_API_KEY` = (leave empty for now)
- [ ] `GENERO_API_BASE_URL` = (leave empty for now)
- [ ] `GENERO_API_KEY` = (leave empty for now)
- [ ] `BARCODE_BEEP_ON_SCAN` = true
- [ ] `BARCODE_TIMEOUT_MS` = 500

### Build Configuration
- [ ] Railway detected Node.js app (package.json in apps/warehouse-backend/)
- [ ] Build command: `npm install && npm run build`
- [ ] Start command: `npm start`
- [ ] Both configured in Railway (auto-detected usually)

---

## 🗄️ Database Initialization

### Migrations
- [ ] Database migrations run successfully on first deploy
  ```bash
  # In Railway terminal or CI/CD hook:
  npm run db:migrate
  ```
- [ ] All 13 tables created
- [ ] Indexes created
- [ ] No errors in migration logs

### Initial Data (Optional)
- [ ] Decide: seed test data or start empty?
  ```bash
  # If seeding test data:
  npm run db:seed
  # Creates: 20 locations, 9 barcodes, 3 users, 15 inventory records
  ```
- [ ] If NOT seeding, confirm production database is empty

### Verify Tables
- [ ] Log into Railway PostgreSQL terminal
  ```bash
  \dt  -- List tables
  \d warehouse_locations  -- Describe table
  ```
- [ ] Confirm all tables exist:
  - warehouse_locations
  - warehouse_inventory
  - barcode_mappings
  - pick_lists
  - pick_list_items
  - warehouse_movements
  - warehouse_users
  - supplier_orders
  - supplier_order_items
  - audit_log

---

## 🔐 Security Checklist

### Secrets & Keys
- [ ] JWT_SECRET is strong (min 32 chars, random)
- [ ] No secrets in `.env.example` (only placeholders)
- [ ] No secrets committed to Git (check: `git log --all -p | grep -i password`)
- [ ] Medusa API key NOT stored in code (environment var only)
- [ ] Genero API key NOT stored in code (environment var only)

### Authentication
- [ ] JWT validation middleware active on all routes
- [ ] Role-based access control implemented (ADMIN, MANAGER, PICKER)
- [ ] Invalid tokens rejected with 401 status
- [ ] Expired tokens rejected with 401 status

### Database
- [ ] No root/admin database credentials in code
- [ ] PostgreSQL connection uses encrypted connection string
- [ ] Connection pool limits set (max: 20 idle connections)

### API Security
- [ ] CORS restricted to known origins (Medusa, Vercel, etc)
- [ ] No sensitive data in error messages
- [ ] Rate limiting considered (not urgent for Phase 1)
- [ ] SQL injection prevented (using parameterized queries)

---

## 📊 Monitoring & Logging

### Logging
- [ ] Server startup logs visible in Railway logs
- [ ] Database connection logged
- [ ] API requests can be traced (use audit_log table)
- [ ] Errors logged with stack trace
- [ ] No sensitive data logged (no passwords, tokens, etc)

### Health Check
- [ ] `/health` endpoint responds `{"status": "ok"}`
- [ ] Railway health check configured to call `/health`
- [ ] Auto-restart on failure enabled

### Monitoring (Post-Deployment)
- [ ] Railway dashboard shows green ✓
- [ ] CPU usage reasonable (<50%)
- [ ] Memory usage reasonable (<200MB)
- [ ] Database connection pool healthy
- [ ] Error rate <1%

---

## 🧪 Smoke Tests (After Deploy)

### Basic Connectivity
- [ ] Health endpoint responds: `curl https://warehouse-wms.railway.app/health`
- [ ] Expected: `{"status": "ok", "timestamp": "..."}`

### Authentication
- [ ] Generate test JWT token (see README.md)
- [ ] Invalid token rejected: `curl -H "Authorization: Bearer INVALID"`
- [ ] Expected: 401 status

### Database Connection
- [ ] Any endpoint hits database (e.g., `/api/pick-lists`)
- [ ] No connection errors in logs
- [ ] Response time reasonable (<200ms)

### Barcode Scanning
- [ ] Test scan endpoint: `POST /api/scanning/scan`
- [ ] Valid barcode accepted: `{"barcode": "H2910NL-BLK"}`
- [ ] Invalid barcode rejected
- [ ] Error messages clear

### Pick Lists
- [ ] List endpoint returns empty or seeded data: `GET /api/pick-lists`
- [ ] Create endpoint works: `POST /api/pick-lists`

### Audit Trail
- [ ] Confirm movements logged: check `warehouse_movements` table
- [ ] Each test action appears in audit_log

---

## 📝 Deployment Notes

### What Happens During Deploy
1. Railway pulls latest code from GitHub
2. Installs dependencies: `npm install`
3. Compiles TypeScript: `npm run build`
4. Creates dist/ folder
5. Starts server: `npm start`
6. Server connects to PostgreSQL
7. App responds to requests

### If Deploy Fails
- [ ] Check Railway build logs for errors
- [ ] Verify `package.json` is in `apps/warehouse-backend/`
- [ ] Check for TypeScript compilation errors: `npm run build`
- [ ] Verify environment variables set in Railway dashboard
- [ ] Check database connection string is correct

### If App Crashes After Deploy
- [ ] Check Railway runtime logs for errors
- [ ] Verify database is accessible: `psql $DATABASE_URL`
- [ ] Check PostgreSQL hasn't run out of connections
- [ ] Restart deployment from Railway dashboard

---

## 📱 Post-Deployment

### User Access
- [ ] Mark has WMS URL: https://warehouse-wms.railway.app
- [ ] Mark has login credentials (email/password)
- [ ] Mark can authenticate (JWT token issued)
- [ ] Mark can scan barcode without errors

### Operational
- [ ] Backup strategy in place (Railway auto-backups)
- [ ] Logs monitored for errors (Railway dashboard)
- [ ] Performance monitored (CPU, memory, response time)
- [ ] Database size monitored (will grow over time)

### Maintenance
- [ ] Document production database credentials (secure location)
- [ ] Set up alerting if uptime drops below 99.9%
- [ ] Plan quarterly backup restore test
- [ ] Track database growth & plan scaling if needed

---

## 🎉 Deployment Success Criteria

✅ Server starts without errors  
✅ Database migrations complete  
✅ Health check endpoint responds  
✅ Authentication works (valid/invalid tokens)  
✅ Barcode scanning works end-to-end  
✅ Pick list operations work  
✅ Audit trail logged  
✅ No critical errors in logs  
✅ Response times acceptable (<500ms)  
✅ Mark can log in & scan barcodes  

---

## 📞 Support & Rollback

### If Something Goes Wrong
1. **Check Railway logs:** Dashboard → Deployments → Select build → View logs
2. **Check database:** Railway PostgreSQL terminal
3. **Rollback:** Railway dashboard → Deployments → Select previous version → Redeploy

### Emergency Contacts
- **Database emergency:** Railway support (railway.app/support)
- **Code issue:** Developer (check Git logs)
- **Genero integration:** Wait for Bisley DevOps call

---

## ✅ Sign-Off

- [ ] All checklist items completed
- [ ] Deployment approved by tech lead
- [ ] Mark trained on WMS basic operations
- [ ] Documentation reviewed for accuracy
- [ ] Backup plan confirmed

**Deployment Date:** _______________  
**Deployed By:** _______________  
**Verified By:** _______________

---

## 📚 Additional Resources

- [README.md](./README.md) — Full API documentation
- [SETUP.md](./SETUP.md) — Setup instructions
- [MARK-QUICK-START.md](./MARK-QUICK-START.md) — Operator guide
- [WAREHOUSE-WMS-PHASE-1.md](../../WAREHOUSE-WMS-PHASE-1.md) — Project overview
- [Railway Docs](https://docs.railway.app/) — Deployment help

