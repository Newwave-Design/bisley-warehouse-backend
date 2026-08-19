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
  } catch (error) {
    console.error('❌ Startup failed:', error);
    process.exit(1);
  }
}

// Graceful shutdown
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
