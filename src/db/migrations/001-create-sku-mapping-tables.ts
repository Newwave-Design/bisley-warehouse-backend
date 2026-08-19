/**
 * Migration: Create SKU Mapping Tables
 * Phase 1: Inventory Intake & SKU Mapping
 * 
 * Creates two tables:
 * 1. sku_mappings - Maps NW codes to Medusa SKUs and Genero codes
 * 2. nw_stocking_items - Individual inventory items from NW stocking programme
 */

import { query } from '../index.js';

export async function up() {
  console.log('🔄 Creating sku_mappings table...');
  
  await query(`
    CREATE TABLE IF NOT EXISTS sku_mappings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nw_code VARCHAR UNIQUE NOT NULL,
      medusa_sku VARCHAR,
      genero_code VARCHAR,
      product_name VARCHAR,
      family VARCHAR,
      colour VARCHAR,
      status TEXT CHECK (status IN ('UNMAPPED', 'ASSUMED', 'VALIDATED', 'REJECTED')) DEFAULT 'UNMAPPED',
      notes TEXT,
      mapped_by VARCHAR,
      mapped_at TIMESTAMP,
      confidence FLOAT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_sku_mappings_nw_code ON sku_mappings(nw_code)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_sku_mappings_status ON sku_mappings(status)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_sku_mappings_family ON sku_mappings(family)
  `);

  console.log('✓ sku_mappings table created');

  console.log('🔄 Creating nw_stocking_items table...');

  await query(`
    CREATE TABLE IF NOT EXISTS nw_stocking_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nw_code VARCHAR NOT NULL,
      description VARCHAR,
      family VARCHAR,
      colour VARCHAR,
      quantity_ordered INT,
      unit_cost DECIMAL(10,2),
      mapping_id UUID REFERENCES sku_mappings(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_nw_stocking_nw_code ON nw_stocking_items(nw_code)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_nw_stocking_mapping_id ON nw_stocking_items(mapping_id)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_nw_stocking_family ON nw_stocking_items(family)
  `);

  console.log('✓ nw_stocking_items table created');
}

export async function down() {
  console.log('⬅️ Dropping nw_stocking_items table...');
  await query('DROP TABLE IF EXISTS nw_stocking_items CASCADE');
  
  console.log('⬅️ Dropping sku_mappings table...');
  await query('DROP TABLE IF EXISTS sku_mappings CASCADE');
  
  console.log('✓ Tables dropped');
}
