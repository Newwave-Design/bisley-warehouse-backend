/**
 * Warehouse Management System - Server
 * Bisley Shop Warehouse Backend
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initializePool, closePool } from './db/index.js';
import scanningRoutes from './api/routes/scanning.js';
import pickListRoutes from './api/routes/pick-lists.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://bisley-shop.medusajs.app',
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
  try {
    console.log('🏭 Warehouse Management System');
    console.log('Environment:', process.env.NODE_ENV);
    
    // Initialize database pool
    initializePool();
    console.log('✓ Database pool initialized');

    // Test connection
    const result = await import('./db/index.js').then(m => m.query('SELECT NOW()'));
    console.log('✓ Database connection verified');

    // Start server
    app.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`  Health: http://localhost:${PORT}/health`);
      console.log(`  API: http://localhost:${PORT}/api`);
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
