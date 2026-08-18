/**
 * Database Seed Script
 * Populates initial warehouse locations, users, and test data
 */

import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

const { Client } = pg;

async function seed() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('🌱 Seeding database...');

    // Clear existing data (optional - comment out for production)
    console.log('\n🗑️  Clearing existing data...');
    await client.query('TRUNCATE warehouse_locations, warehouse_inventory, barcode_mappings, warehouse_users CASCADE');

    // 1. Create warehouse locations (A1-A10, B1-B10)
    console.log('\n📍 Creating warehouse locations...');
    const locations = [];
    for (let bay = 65; bay <= 66; bay++) { // A, B
      for (let bin = 1; bin <= 10; bin++) {
        const bayCode = String.fromCharCode(bay);
        const locationCode = `${bayCode}${bin}`;
        const result = await client.query(
          `INSERT INTO warehouse_locations (id, bay_code, bin_code, location_code, description, max_weight_kg, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, true)
           RETURNING id`,
          [
            uuidv4(),
            bayCode,
            bin.toString(),
            locationCode,
            `Bay ${bayCode}, Bin ${bin}`,
            100.00,
          ]
        );
        locations.push({ code: locationCode, id: result.rows[0].id });
      }
    }
    console.log(`✓ Created ${locations.length} locations (A1-A10, B1-B10)`);

    // 2. Create barcode mappings
    console.log('\n🏷️  Creating barcode mappings...');
    const barcodes = [
      { sku: 'H2910NL', colour: 'BLK', colourName: 'Black' },
      { sku: 'H2910NL', colour: 'WHT', colourName: 'White' },
      { sku: 'H2910NL', colour: 'RED', colourName: 'Red' },
      { sku: 'H2920NL', colour: 'BLK', colourName: 'Black' },
      { sku: 'H2920NL', colour: 'BLU', colourName: 'Blue' },
      { sku: 'E4D4L', colour: 'GRN', colourName: 'Green' },
      { sku: 'E4D4L', colour: 'OLV', colourName: 'Olive' },
      { sku: 'A3D2', colour: 'CRM', colourName: 'Cream' },
      { sku: 'A3D2', colour: 'GRY', colourName: 'Grey' },
    ];

    for (const bc of barcodes) {
      await client.query(
        `INSERT INTO barcode_mappings (id, barcode, product_sku, colour_code, colour_name, is_active)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [
          uuidv4(),
          `${bc.sku}-${bc.colour}`,
          bc.sku,
          bc.colour,
          bc.colourName,
        ]
      );
    }
    console.log(`✓ Created ${barcodes.length} barcode mappings`);

    // 3. Create test warehouse users
    console.log('\n👤 Creating warehouse users...');
    const users = [
      { name: 'Mark', email: 'mark@bisley.com', role: 'PICKER' },
      { name: 'Admin', email: 'admin@bisley.com', role: 'ADMIN' },
      { name: 'Manager', email: 'manager@bisley.com', role: 'MANAGER' },
    ];

    const createdUsers = [];
    for (const user of users) {
      const result = await client.query(
        `INSERT INTO warehouse_users (id, medusa_user_id, name, email, role, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING id`,
        [
          uuidv4(),
          `user_${user.name.toLowerCase()}`,
          user.name,
          user.email,
          user.role,
        ]
      );
      createdUsers.push(result.rows[0].id);
    }
    console.log(`✓ Created ${users.length} users`);

    // 4. Add initial inventory to some locations
    console.log('\n📦 Populating initial inventory...');
    let inventoryCount = 0;
    for (let i = 0; i < Math.min(5, locations.length); i++) {
      for (let j = 0; j < Math.min(3, barcodes.length); j++) {
        const barcode = barcodes[j];
        const location = locations[i];
        await client.query(
          `INSERT INTO warehouse_inventory (id, location_id, product_sku, colour_code, quantity)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            uuidv4(),
            location.id,
            barcode.sku,
            barcode.colour,
            Math.floor(Math.random() * 20) + 1, // Random 1-20 units
          ]
        );
        inventoryCount++;
      }
    }
    console.log(`✓ Created ${inventoryCount} inventory records`);

    console.log('\n✅ Seed completed successfully!');
    console.log('\n📊 Summary:');
    console.log(`   - Locations: ${locations.length} (bays A-B, bins 1-10)`);
    console.log(`   - Barcode mappings: ${barcodes.length}`);
    console.log(`   - Users: ${users.length}`);
    console.log(`   - Inventory records: ${inventoryCount}`);
    console.log('\n👤 Test users:');
    users.forEach(u => console.log(`   - ${u.email} (role: ${u.role})`));
  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

seed();
