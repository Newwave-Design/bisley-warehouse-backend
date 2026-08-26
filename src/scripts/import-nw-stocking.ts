/**
 * Import NW Stocking Programme
 * Reads: data/spreadsheets/nw-stocking-cheatsheet.xlsx (sheet: Stocking Plan)
 * Columns: Group, Product Code, Colour, Initial Qty, Hex
 * Usage: npx tsx src/scripts/import-nw-stocking.ts
 */
import { read as readXlsx, utils } from "xlsx";
import * as path from "path";
import { fileURLToPath } from "url";
import { query, initializePool, closePool } from "../db/index.js";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const excelPath = path.join(__dirname, "../../../../..", "data/spreadsheets/nw-stocking-cheatsheet.xlsx");

async function run() {
  console.log("NW Stocking Import\n");
  await initializePool();

  console.log("Reading:", excelPath);
  const wb = readXlsx(excelPath);
  const rows = utils.sheet_to_json(wb.Sheets["Stocking Plan"]) as any[];
  console.log(`${rows.length} rows found\n`);

  if (!rows.length) { console.log("No rows - check sheet name"); await closePool(); return; }

  let inserted = 0, updated = 0, errors = 0;

  for (const row of rows) {
    const productCode = String(row["Product Code"] ?? "").trim();
    const colour      = String(row["Colour"]       ?? "").trim();
    const family      = String(row["Group"]        ?? "").trim();
    const qty         = parseInt(row["Initial Qty"], 10) || 0;

    if (!productCode) continue;

    // Composite key so each product-colour combination has its own mapping row
    const nwCode = colour ? `${productCode}-${colour}` : productCode;

    try {
      const r = await query(`
        INSERT INTO sku_mappings (id, nw_code, product_name, family, colour, status, confidence, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'UNMAPPED', 0, NOW(), NOW())
        ON CONFLICT (nw_code) DO UPDATE SET family = EXCLUDED.family, colour = EXCLUDED.colour, updated_at = NOW()
        RETURNING (xmax = 0) AS is_insert
      `, [uuidv4(), nwCode, family + " - " + colour, family, colour]);

      const isNew = r.rows[0]?.is_insert;
      if (isNew) inserted++; else updated++;

      const mappingId = (await query("SELECT id FROM sku_mappings WHERE nw_code = $1", [nwCode])).rows[0]?.id;
      if (mappingId) {
        await query(`
          INSERT INTO nw_stocking_items (id, nw_code, description, family, colour, quantity_ordered, mapping_id, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW()) ON CONFLICT DO NOTHING
        `, [uuidv4(), nwCode, `${family} - ${colour}`, family, colour, qty, mappingId]);
      }
    } catch (e: any) {
      console.error(`  ERR ${nwCode}: ${e.message?.slice(0, 80)}`);
      errors++;
    }
  }

  console.log(`\nDone: ${inserted} new, ${updated} updated, ${errors} errors`);
  console.log("Total sku_mappings:", (await query("SELECT COUNT(*) FROM sku_mappings")).rows[0].count);
  await closePool();
}

run().catch(e => { console.error(e); process.exit(1); });
