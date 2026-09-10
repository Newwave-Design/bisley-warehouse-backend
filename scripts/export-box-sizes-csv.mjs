#!/usr/bin/env node

/**
 * Export Box Size Summary to CSV
 * 
 * Usage: node scripts/export-box-sizes-csv.mjs [BASE_URL]
 * 
 * Aggregates box_size_requirements by protection_type and dimensions to show:
 * - Unique box sizes needed
 * - Total monthly sales (units) for all product ranges using each box
 * - Product ranges included in each box size
 * 
 * Args:
 *   BASE_URL - Optional API base URL (default: https://bisley-warehouse-backend-production.up.railway.app)
 * 
 * Environment:
 *   WMS_API_TOKEN - JWT token for authentication (required if not using local dev)
 * 
 * Output: data/exports/box-sizes-summary-{timestamp}.csv
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.argv[2] || 'https://bisley-warehouse-backend-production.up.railway.app';
const TOKEN = process.env.WMS_API_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBiaXNsZXkuY29tIiwicm9sZSI6Ik1BTkFHRVIifQ.demo';

async function main() {
  try {
    console.log(`Fetching box size requirements from ${BASE_URL}...`);

    // Fetch box sizes from API
    const response = await fetch(`${BASE_URL}/api/box-sizes`, {
      headers: {
        'Authorization': `Bearer ${TOKEN}`
      }
    });
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const boxSizes = data.requirements || [];

    // Group by protection_type and internal dimensions
    const boxGroups = new Map();
    
    for (const box of boxSizes) {
      const boxKey = `${box.protection_type || 'standard'}_${box.box_internal_width_mm}_${box.box_internal_depth_mm}_${box.box_internal_height_mm}`;
      
      if (!boxGroups.has(boxKey)) {
        boxGroups.set(boxKey, {
          protection_type: box.protection_type || 'Standard',
          box_width: box.box_internal_width_mm,
          box_depth: box.box_internal_depth_mm,
          box_height: box.box_internal_height_mm,
          product_ranges: [],
          total_monthly_units: 0
        });
      }
      
      const group = boxGroups.get(boxKey);
      
      // Calculate estimated monthly sales from matched products' total stock
      let totalStock = 0;
      for (const product of box.matched_products || []) {
        totalStock += product.total_stock || 0;
      }
      const estimatedMonthlySales = totalStock > 0 ? Math.round(totalStock / 2) : 0;
      
      if (estimatedMonthlySales > 0) {
        group.product_ranges.push({
          name: box.product_range,
          label: box.product_label,
          monthly_units: estimatedMonthlySales
        });
        group.total_monthly_units += estimatedMonthlySales;
      }
    }

    // Build CSV
    const rows = [
      '"Box ID","Protection Type","Box Internal Dims (W×D×H mm)","Total Monthly Units","Product Ranges (Count)","Product Ranges Breakdown"'
    ];

    let boxNumber = 1;
    for (const [key, group] of boxGroups) {
      const dims = `${group.box_width}×${group.box_depth}×${group.box_height}`;
      const breakdown = group.product_ranges
        .map(pr => `${pr.name}${pr.label ? ` (${pr.label})` : ''}: ${pr.monthly_units} units`)
        .join('; ');

      rows.push([
        `BOX-${String(boxNumber).padStart(2, '0')}`,
        group.protection_type,
        dims,
        group.total_monthly_units.toString(),
        group.product_ranges.length.toString(),
        `"${breakdown.replace(/"/g, '""')}"`
      ].join(','));

      boxNumber++;
    }

    // Write CSV file
    const exportDir = join(__dirname, '../../..', 'data', 'exports');
    mkdirSync(exportDir, { recursive: true });
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = join(exportDir, `box-sizes-summary-${timestamp}.csv`);

    writeFileSync(filename, rows.join('\n'), 'utf-8');

    console.log(`✓ CSV exported: ${filename}`);
    console.log(`  Unique box sizes: ${boxGroups.size}`);
    console.log(`  Total monthly units across all boxes: ${Array.from(boxGroups.values()).reduce((sum, g) => sum + g.total_monthly_units, 0)}`);
  } catch (err) {
    console.error('Export failed:', err);
    process.exit(1);
  }
}

main();
