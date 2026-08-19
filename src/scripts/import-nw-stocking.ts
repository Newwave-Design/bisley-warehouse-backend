/**
 * Import NW Stocking Programme
 * Loads product codes from nw-stocking-cheatsheet.xlsx
 * 
 * Usage: npx tsx src/scripts/import-nw-stocking.ts
 */

import { read as readFile, utils } from 'xlsx';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db/index.js';
import { initializePool, closePool } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const excelPath = path.join(__dirname, '../../../..', 'data/spreadsheets/nw-stocking-cheatsheet.xlsx');

interface StockingItem {
  nw_code: string;
  description: string;
  family: string;
  colour: string;
  quantity_ordered: number;
  unit_cost?: number;
}

/**
 * Parse the Excel file and extract items
 */
async function parseExcelFile(): Promise<StockingItem[]> {
  console.log(`📂 Reading Excel file: ${excelPath}`);

  const workbook = readFile(excelPath);
  const items: StockingItem[] = [];
  const processedCodes = new Set<string>();

  // List of sheets to process (families in the NW programme)
  const sheetsToProcess = [
    'Home Filer',
    'MultiDrawer',
    'BS Filing',
    'Fern',
    'Note Pedestal',
    'MultiDesk',
  ];

  for (const sheetName of sheetsToProcess) {
    if (!workbook.SheetNames.includes(sheetName)) {
      console.log(`⚠️  Sheet not found: ${sheetName}`);
      continue;
    }

    console.log(`🔄 Processing sheet: ${sheetName}`);
    const worksheet = workbook.Sheets[sheetName];
    const data = utils.sheet_to_json(worksheet) as any[];

    // Extract colour columns (all columns except the first one which has product codes)
    const colourColumns = worksheet['!ref']
      ? utils.decode_range(worksheet['!ref']).e.c > 0
        ? Object.keys(data[0] || {}).slice(1)
        : []
      : [];

    for (const row of data) {
      // First column contains the product code
      const nwCode = Object.values(row)[0]?.toString().trim();
      const description = Object.values(row)[0]?.toString().trim();

      if (!nwCode) continue;

      // Process each colour column
      for (const colourColumn of colourColumns) {
        const quantity = parseInt(row[colourColumn], 10) || 0;

        if (quantity <= 0) continue; // Skip zero quantities

        const colour = colourColumn.trim();
        const compositeKey = `${nwCode}-${colour}`;

        // Skip duplicates
        if (processedCodes.has(compositeKey)) continue;
        processedCodes.add(compositeKey);

        items.push({
          nw_code: nwCode,
          description,
          family: sheetName,
          colour,
          quantity_ordered: quantity,
          unit_cost: 0, // Will be filled in later if needed
        });
      }
    }
  }

  console.log(`✓ Parsed ${items.length} items from Excel`);
  return items;
}

/**
 * Insert items into database
 */
async function insertItems(items: StockingItem[]): Promise<number> {
  let createdMappings = 0;
  let createdItems = 0;

  // Group by nw_code for mapping table
  const mappingMap = new Map<string, StockingItem>();
  for (const item of items) {
    if (!mappingMap.has(item.nw_code)) {
      mappingMap.set(item.nw_code, item);
    }
  }

  // Insert into sku_mappings
  console.log(`🔄 Inserting ${mappingMap.size} unique mappings...`);
  for (const [nwCode, item] of mappingMap.entries()) {
    try {
      await query(
        `INSERT INTO sku_mappings (
          id, nw_code, product_name, family, colour, status, confidence, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        ON CONFLICT (nw_code) DO NOTHING`,
        [uuidv4(), nwCode, item.description, item.family, item.colour, 'UNMAPPED', 0]
      );
      createdMappings++;
    } catch (error) {
      console.error(`❌ Error inserting mapping ${nwCode}:`, error);
    }
  }

  console.log(`✓ Created ${createdMappings} mappings`);

  // Insert into nw_stocking_items
  console.log(`🔄 Inserting ${items.length} inventory items...`);
  for (const item of items) {
    try {
      // Get the mapping ID for this nw_code
      const mappingResult = await query(
        'SELECT id FROM sku_mappings WHERE nw_code = $1',
        [item.nw_code]
      );
      const mappingId = mappingResult.rows[0]?.id;

      await query(
        `INSERT INTO nw_stocking_items (
          id, nw_code, description, family, colour, quantity_ordered, unit_cost, mapping_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
        [
          uuidv4(),
          item.nw_code,
          item.description,
          item.family,
          item.colour,
          item.quantity_ordered,
          item.unit_cost || 0,
          mappingId || null,
        ]
      );
      createdItems++;
    } catch (error) {
      console.error(`❌ Error inserting item ${item.nw_code}-${item.colour}:`, error);
    }
  }

  console.log(`✓ Created ${createdItems} inventory items`);
  return createdItems;
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 NW Stocking Import Script');
  console.log('');

  try {
    // Initialize database
    initializePool();

    // Parse Excel
    const items = await parseExcelFile();

    if (items.length === 0) {
      console.log('⚠️  No items to import');
      return;
    }

    // Insert items
    const inserted = await insertItems(items);

    console.log('');
    console.log('✅ Import complete!');
    console.log(`   Total items inserted: ${inserted}`);
    console.log('');

    // Show summary
    const countResult = await query(
      `SELECT 
        COUNT(*) as total_items,
        COUNT(DISTINCT nw_code) as unique_codes,
        COUNT(DISTINCT family) as families
       FROM nw_stocking_items`
    );

    const { total_items, unique_codes, families } = countResult.rows[0];
    console.log('📊 Database Summary:');
    console.log(`   Total items: ${total_items}`);
    console.log(`   Unique NW codes: ${unique_codes}`);
    console.log(`   Families: ${families}`);
  } catch (error) {
    console.error('❌ Import failed:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
