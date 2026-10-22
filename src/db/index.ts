import * as pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function initializePool() {
  if (pool) return pool;

  const dbUrl = process.env.WAREHOUSE_DATABASE_URL ||
                process.env.DATABASE_URL ||
                process.env.NEON_DATABASE_URL;

  if (!dbUrl) {
    console.warn('⚠️  WAREHOUSE_DATABASE_URL / DATABASE_URL not set - database connections will fail');
  }

  pool = new Pool({
    connectionString: dbUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
  });

  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initializePool first.');
  }
  return pool;
}

export async function query(text: string, params?: any[]) {
  const pool = getPool();
  return pool.query(text, params);
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
