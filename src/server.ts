/**
 * Warehouse Management System - Server
 * Bisley Shop Warehouse Backend
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initializePool, closePool } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import scanningRoutes from './api/routes/scanning.js';
import pickListRoutes from './api/routes/pick-lists.js';
import inventorySyncRoutes from './api/routes/inventory-sync.js';
import skuMappingsRoutes from './api/routes/sku-mappings.js';
import ordersRoutes from './api/routes/orders.js';
import checkinRoutes from './api/routes/checkin.js';
import receivingRoutes from './api/routes/receiving.js';
import productsRoutes from './api/routes/products.js';
import settingsRoutes from './api/routes/settings.js';
import dashboardRoutes from './api/routes/dashboard.js';
import generoRoutes from './api/routes/genero.js';
import reportsRoutes from './api/routes/reports.js';
import mobileRoutes from './api/routes/mobile.js';
import webhooksRoutes from './api/routes/webhooks.js';
import reorderRulesRoutes, { pendingRouter as pendingReordersRouter, runReorderCheck } from './api/routes/reorder-rules.js';
import errorLogRoutes from './api/routes/error-log.js';
import notificationsRoutes from './api/routes/notifications.js';
import deliveriesRoutes from './api/routes/deliveries.js';
import { createNotificationOnce } from './lib/notifications.js';
import { runDiscrepancyCheck } from './lib/discrepancy-check.js';
import { query as dbQueryUtil } from './db/index.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:5176',
    'https://bisley-shop.medusajs.app',
    'https://bisley-warehouse-dashboard-production.up.railway.app',
  ],
  credentials: true,
}));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/scanning', scanningRoutes);
app.use('/api/pick-lists', pickListRoutes);
app.use('/api/inventory', inventorySyncRoutes);
app.use('/api/sku-mappings', skuMappingsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/checkin', checkinRoutes);
app.use('/api/receiving', receivingRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/genero', generoRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/mobile', mobileRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/reorder-rules', reorderRulesRoutes);
app.use('/api/pending-reorders', pendingReordersRouter);
app.use('/api/error-log', errorLogRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/deliveries', deliveriesRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// Startup
async function start() {
  // Debug logging
  console.log('🚀 Warehouse Management System Starting...');
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔌 Port: ${PORT}`);
  console.log(`🔐 JWT_SECRET configured: ${process.env.JWT_SECRET ? 'Yes' : 'No'}`);
  console.log(`📦 DATABASE_URL: ${process.env.DATABASE_URL ? 'Set' : 'MISSING'}`);
  console.log(`🗄️ Node version: ${process.version}`);
  console.log('');
  try {
    // Initialize database pool
    try {
      initializePool();
      console.log('✓ Database pool initialized');
    } catch (dbError) {
      console.warn('⚠️  Database initialization warning:', (dbError as Error).message);
    }

    // Run migrations automatically on startup
    try {
      await runMigrations();
      console.log('✓ Database migrations complete');
    } catch (migrateError) {
      console.warn('⚠️  Migration warning:', (migrateError as Error).message);
    }

    // Start server
    app.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`  Health: http://localhost:${PORT}/health`);
      console.log(`  API: http://localhost:${PORT}/api`);
      console.log('');
    });

    // Scheduled Genero poll — every 2 hours in production if API URL is configured
    if (process.env.NODE_ENV === 'production' && process.env.GENERO_API_URL) {
      const TWO_HOURS = 2 * 60 * 60 * 1000;
      setInterval(async () => {
        const h = new Date().getHours();
        if (h < 7 || h > 19) return; // only poll during business hours (7am–7pm)
        try {
          const { query: dbQuery } = await import('./db/index.js');
          const open = await dbQuery(`SELECT COUNT(*) FROM genero_order_lines WHERE genero_status NOT IN ('Received','Cancelled','Complete','Delivered') OR genero_status IS NULL`);
          if (parseInt(open.rows[0].count) > 0) {
            const token = `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64')}.${Buffer.from(JSON.stringify({ sub: 'scheduler', email: 'scheduler@wms', role: 'MANAGER' })).toString('base64')}.sig`;
            await fetch(`http://localhost:${PORT}/api/genero/poll`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
            console.log(`[scheduler] Genero poll ran at ${new Date().toISOString()}`);
            // Also run reorder check after each Genero poll
            const triggered = await runReorderCheck();
            if (triggered.length > 0) console.log(`[scheduler] Reorder check triggered ${triggered.length} pending reorders: ${triggered.slice(0,5).join(', ')}`);

            // Daily operational checks: unassigned inventory + deliveries today
            await runDailyChecks();
          }
        } catch (err) { console.warn('[scheduler] Genero poll error:', err); }
      }, TWO_HOURS);
      console.log('✓ Genero auto-poll scheduled (every 2h, business hours)');
    }

    // Scheduled inventory discrepancy check — every 30 minutes in production, any time of day
    if (process.env.NODE_ENV === 'production') {
      const THIRTY_MIN = 30 * 60 * 1000;
      setInterval(async () => {
        try {
          const result = await runDiscrepancyCheck();
          console.log(`[scheduler] Discrepancy check: ${result.checked} SKUs, ${result.mismatches} mismatches (${result.newlyLogged} newly logged, ${result.autoResolved} auto-resolved)`);
          if (result.newlyLogged > 0) {
            await createNotificationOnce('INVENTORY_DISCREPANCY',
              `${result.newlyLogged} new inventory discrepanc${result.newlyLogged === 1 ? 'y' : 'ies'} found`,
              'WMS physical stock and Medusa quantities disagree for one or more SKUs — check the Error Log.',
              { link: '/error-log', severity: 'warning', metadata: { newly_logged: result.newlyLogged } }
            );
          }
        } catch (err) { console.warn('[scheduler] Discrepancy check error:', err); }
      }, THIRTY_MIN);
      console.log('✓ Inventory discrepancy check scheduled (every 30 min)');
    }
  } catch (error) {
    console.error('❌ Startup failed:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function runDailyChecks() {
  try {
    // Unassigned inventory notification
    const unassigned = await dbQueryUtil(`SELECT COUNT(*)::int AS c FROM requires_location_queue WHERE status='PENDING'`);
    const n = unassigned.rows[0].c;
    if (n > 0) {
      await createNotificationOnce('INVENTORY_UNASSIGNED',
        `${n} item${n !== 1 ? 's' : ''} awaiting bay assignment`,
        'Stock has been received but not yet assigned to a warehouse bay.',
        { link: '/receiving', severity: 'warning', metadata: { count: n } }
      );
    }
    // Any deliveries expected today not yet arrived?
    const today = new Date().toISOString().split('T')[0];
    const dueToday = await dbQueryUtil(
      `SELECT count(*)::int AS c FROM genero_deliveries WHERE est_delivery=$1 AND status NOT IN ('CHECKED_IN','CANCELLED')`,
      [today]
    );
    if (dueToday.rows[0].c > 0) {
      await createNotificationOnce('DELIVERY_TODAY',
        `${dueToday.rows[0].c} delivery expected today`,
        'Check the Deliveries page to see what to expect and start a check-in when stock arrives.',
        { link: '/deliveries', severity: 'warning' }
      );
    }
  } catch (err) { console.warn('[daily-checks] error:', err); }
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await closePool();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await closePool();
  process.exit(0);
});

start();
