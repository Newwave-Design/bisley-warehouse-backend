/**
 * Pick List API
 * Endpoints for managing pick lists and picking operations
 */

import express, { Request, Response } from 'express';
import { query } from '../../db/index.js';
import { authMiddleware } from '../../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { syncSkuToMedusa } from '../../lib/medusa-inventory.js';
import { createUpsShipmentLabel } from '../../lib/ups.js';

const router = express.Router();

/** GET /api/pick-lists/sandbox — list only sandbox pick lists (must be before /:pickListId) */
router.get('/sandbox', authMiddleware, async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT pl.id, pl.pick_list_number, pl.medusa_order_id, pl.status, pl.created_at,
              COUNT(pli.id)::int AS item_count, SUM(CASE WHEN pli.status='PICKED' THEN 1 ELSE 0 END)::int AS items_picked
       FROM pick_lists pl LEFT JOIN pick_list_items pli ON pli.pick_list_id = pl.id
       WHERE pl.is_sandbox = true GROUP BY pl.id ORDER BY pl.created_at DESC`
    );
    res.json({ pickLists: result.rows });
  } catch (e) { res.status(500).json({ error: 'Failed to load sandbox lists' }); }
});

/** POST /api/pick-lists/sandbox/reset — reset sandbox pick lists back to PENDING */
router.post('/sandbox/reset', authMiddleware, async (req: Request, res: Response) => {
  try {
    await query(`UPDATE pick_lists SET status='PENDING', updated_at=NOW() WHERE is_sandbox=true`);
    await query(`UPDATE pick_list_items SET status='PENDING', quantity_picked=0, picked_from_location_id=NULL, updated_at=NOW() WHERE is_sandbox=true`);
    const count = await query(`SELECT COUNT(*) AS c FROM pick_lists WHERE is_sandbox=true`);
    res.json({ success: true, message: `Reset ${count.rows[0].c} sandbox pick list(s) to PENDING` });
  } catch (e) { res.status(500).json({ error: 'Failed to reset sandbox' }); }
});

/**
 * GET /api/pick-lists
 * List all active pick lists (with status filtering)
 * 
 * Query params: ?status=PENDING,IN_PROGRESS&limit=50&offset=0
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { status = 'PENDING,IN_PROGRESS', limit = '50', offset = '0' } = req.query;

    const statuses = (status as string).toUpperCase().split(',').map(s => s.trim());

    const result = await query(
      `SELECT 
         pl.id,
         pl.pick_list_number,
         pl.medusa_order_id,
         pl.status,
         pl.created_at,
         COUNT(pli.id) as item_count,
         SUM(CASE WHEN pli.status = 'PICKED' THEN 1 ELSE 0 END) as items_picked
       FROM pick_lists pl
       LEFT JOIN pick_list_items pli ON pli.pick_list_id = pl.id
       WHERE pl.status = ANY($1::text[])
       GROUP BY pl.id
       ORDER BY pl.created_at ASC
       LIMIT $2 OFFSET $3`,
      [statuses, parseInt(limit as string), parseInt(offset as string)]
    );

    return res.json({
      pickLists: result.rows,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
  } catch (error) {
    console.error('Pick list fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch pick lists' });
  }
});

router.get('/:pickListId/fulfilment-plan', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;

    const headerResult = await query(
      `SELECT id, pick_list_number, medusa_order_id, status, customer_name, customer_email,
              shipping_method_name, shipping_method_code, shipping_address,
              selected_courier_code, selected_service_code, shipping_requirements,
              parcel_count, packaging_cost_gbp, packing_notes,
              packing_started_at, packed_at, label_printed_at,
              created_at, updated_at
       FROM pick_lists
       WHERE id = $1`,
      [pickListId]
    );

    if (headerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pick list not found' });
    }

    const [packagesResult, itemsResult, servicesResult, packagingResult, templatesResult] = await Promise.all([
      query(
        `SELECT pkg.*, pp.name AS packaging_profile_name, pp.package_type,
                ss.courier_code, ss.courier_name, ss.service_name, ss.service_level, ss.shipment_mode
         FROM pick_list_packages pkg
         LEFT JOIN packaging_profiles pp ON pp.code = pkg.packaging_profile_code
         LEFT JOIN shipping_services ss ON ss.service_code = pkg.courier_service_code
         WHERE pkg.pick_list_id = $1
         ORDER BY pkg.package_number ASC`,
        [pickListId]
      ),
      query(
        `SELECT pli.id, pli.line_number, pli.product_sku, pli.quantity_required, pli.quantity_picked, pli.status,
                wp.product_title, wp.colour_name, wp.variant_thumbnail,
                pfp.packaging_profile_code, pfp.checklist_template_code, pfp.shipping_group,
                pfp.fulfilment_tags, pfp.preferred_service_code, pfp.requires_manual_review,
                pfp.is_fragile, pfp.is_multi_box, pfp.pack_instructions
         FROM pick_list_items pli
         LEFT JOIN wms_products wp ON wp.variant_sku = pli.product_sku
         LEFT JOIN product_fulfillment_profiles pfp ON pfp.product_sku = pli.product_sku
         WHERE pli.pick_list_id = $1
         ORDER BY pli.line_number ASC`,
        [pickListId]
      ),
      query(
        `SELECT courier_code, courier_name, service_code, service_name, service_level, shipment_mode,
                integration_type, constraints, metadata, sort_order
         FROM shipping_services
         WHERE is_active = true
         ORDER BY sort_order ASC, courier_name ASC, service_name ASC`
      ),
      query(
        `SELECT code, name, package_type, inner_length_mm, inner_width_mm, inner_height_mm,
                max_weight_grams, tare_weight_grams, default_cost_gbp, notes
         FROM packaging_profiles
         WHERE is_active = true
         ORDER BY name ASC`
      ),
      query(
        `SELECT code, name, checklist_items
         FROM packaging_checklist_templates
         WHERE is_active = true
         ORDER BY name ASC`
      ),
    ]);

    return res.json({
      pickList: headerResult.rows[0],
      packages: packagesResult.rows,
      items: itemsResult.rows,
      reference: {
        shipping_services: servicesResult.rows,
        packaging_profiles: packagingResult.rows,
        checklist_templates: templatesResult.rows,
      },
    });
  } catch (error) {
    console.error('Fulfilment plan fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch fulfilment plan' });
  }
});

router.post('/:pickListId/packages/:packageNumber/ups-label', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId, packageNumber } = req.params;
    const packageNum = parseInt(packageNumber, 10);
    if (!Number.isInteger(packageNum)) {
      return res.status(400).json({ error: 'Invalid package number' });
    }

    const pickListResult = await query(
      `SELECT id, pick_list_number, customer_name, customer_email, shipping_address,
              selected_service_code, selected_courier_code
       FROM pick_lists
       WHERE id = $1`,
      [pickListId]
    );
    const pickList = pickListResult.rows[0];
    if (!pickList) return res.status(404).json({ error: 'Pick list not found' });

    const packageResult = await query(
      `SELECT pkg.*, pp.name AS packaging_profile_name, pp.inner_length_mm, pp.inner_width_mm, pp.inner_height_mm,
              ss.service_code, ss.service_name, ss.courier_code, ss.courier_name
       FROM pick_list_packages pkg
       LEFT JOIN packaging_profiles pp ON pp.code = pkg.packaging_profile_code
       LEFT JOIN shipping_services ss ON ss.service_code = COALESCE(pkg.courier_service_code, $3)
       WHERE pkg.pick_list_id = $1 AND pkg.package_number = $2`,
      [pickListId, packageNum, pickList.selected_service_code ?? null]
    );
    const pkg = packageResult.rows[0];
    if (!pkg) return res.status(400).json({ error: 'Package not found - save the packing plan first' });

    const courierCode = pkg.courier_code ?? pickList.selected_courier_code
    if (courierCode !== 'ups') {
      return res.status(400).json({ error: 'Selected package is not configured for UPS' });
    }

    const shippingAddress = pickList.shipping_address ?? {}
    const shipToName = pickList.customer_name || pickList.customer_email || 'Customer'
    const packageWeightGrams = Number(pkg.package_weight_grams ?? 0)
    const weightKg = packageWeightGrams > 0 ? packageWeightGrams / 1000 : 1
    const lengthCm = Number(pkg.package_length_mm ?? pkg.inner_length_mm ?? 0) / 10 || null
    const widthCm = Number(pkg.package_width_mm ?? pkg.inner_width_mm ?? 0) / 10 || null
    const heightCm = Number(pkg.package_height_mm ?? pkg.inner_height_mm ?? 0) / 10 || null

    if (!shippingAddress.address_1 || !shippingAddress.city || !shippingAddress.postal_code || !shippingAddress.country_code) {
      return res.status(400).json({ error: 'Shipping address is incomplete for UPS label generation' });
    }

    const label = await createUpsShipmentLabel({
      serviceCode: pkg.service_code ?? pickList.selected_service_code,
      serviceDescription: pkg.service_name ?? 'UPS Service',
      customerContext: `${pickList.pick_list_number} pkg ${pkg.package_number}`,
      shipTo: {
        name: shipToName,
        attentionName: shipToName,
        phone: shippingAddress.phone ?? null,
        email: pickList.customer_email ?? null,
        addressLine1: shippingAddress.address_1,
        addressLine2: shippingAddress.address_2 ?? null,
        city: shippingAddress.city,
        stateProvinceCode: shippingAddress.province ?? null,
        postalCode: shippingAddress.postal_code,
        countryCode: shippingAddress.country_code,
      },
      package: {
        description: pkg.contents_summary || `${pickList.pick_list_number} package ${pkg.package_number}`,
        weightKg,
        lengthCm,
        widthCm,
        heightCm,
      },
    })

    const packageMetadata = {
      ...(pkg.metadata ?? {}),
      ups: {
        tracking_number: label.trackingNumber,
        label_format: label.labelFormat,
        graphic_image_base64: label.graphicImage,
        html_image_base64: label.htmlImage,
        alerts: label.alerts,
        generated_at: new Date().toISOString(),
      },
    }

    await query(
      `UPDATE pick_list_packages
       SET tracking_number = $1,
           label_status = 'PRINTED',
           courier_service_code = COALESCE(courier_service_code, $2),
           metadata = $3::jsonb,
           updated_at = NOW()
       WHERE id = $4`,
      [label.trackingNumber, pkg.service_code ?? pickList.selected_service_code, JSON.stringify(packageMetadata), pkg.id]
    )

    await query(
      `UPDATE pick_lists
       SET selected_courier_code = 'ups',
           selected_service_code = COALESCE(selected_service_code, $1),
           label_printed_at = COALESCE(label_printed_at, NOW()),
           status = CASE WHEN status IN ('PICKED', 'PACKING', 'PACKED') THEN 'LABEL_PRINTED' ELSE status END,
           updated_at = NOW()
       WHERE id = $2`,
      [pkg.service_code ?? pickList.selected_service_code, pickListId]
    )

    return res.json({
      success: true,
      tracking_number: label.trackingNumber,
      label_format: label.labelFormat,
      graphic_image_base64: label.graphicImage,
      html_image_base64: label.htmlImage,
      alerts: label.alerts,
    })
  } catch (error) {
    console.error('UPS label generation error:', error)
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate UPS label' })
  }
});

/**
 * GET /api/pick-lists/:pickListId
 * Get detailed view of a specific pick list with all items
 */
router.get('/:pickListId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;

    // Get pick list header
    const headerResult = await query(
      'SELECT * FROM pick_lists WHERE id = $1',
      [pickListId]
    );

    if (headerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pick list not found' });
    }

    const pickList = headerResult.rows[0];

    // Get items in pick list
    const itemsResult = await query(
      `SELECT 
         pli.*,
         wl.location_code,
         wl.bay_code,
         wl.bin_code,
         wp.product_title,
         wp.colour_name,
         wp.variant_thumbnail
       FROM pick_list_items pli
       LEFT JOIN warehouse_locations wl ON wl.id = pli.picked_from_location_id
       LEFT JOIN wms_products wp ON wp.variant_sku = pli.product_sku
       WHERE pli.pick_list_id = $1
       ORDER BY pli.line_number`,
      [pickListId]
    );

    const packagesResult = await query(
      `SELECT pkg.id, pkg.package_number, pkg.packaging_profile_code, pkg.courier_service_code,
              pkg.label_status, pkg.tracking_number, pkg.package_cost_gbp,
              pp.name AS packaging_profile_name,
              ss.courier_name, ss.service_name
       FROM pick_list_packages pkg
       LEFT JOIN packaging_profiles pp ON pp.code = pkg.packaging_profile_code
       LEFT JOIN shipping_services ss ON ss.service_code = pkg.courier_service_code
       WHERE pkg.pick_list_id = $1
       ORDER BY pkg.package_number ASC`,
      [pickListId]
    );

    return res.json({
      pickList,
      items: itemsResult.rows,
      packages: packagesResult.rows,
    });
  } catch (error) {
    console.error('Pick list detail error:', error);
    return res.status(500).json({ error: 'Failed to fetch pick list details' });
  }
});

/**
 * POST /api/pick-lists
 * Create a new pick list from a Medusa order
 * 
 * Input: { medusaOrderId: "...", notes?: "..." }
 */
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { medusaOrderId, notes } = req.body;

    if (!medusaOrderId) {
      return res.status(400).json({ error: 'medusaOrderId required' });
    }

    // Check if pick list already exists
    const existingResult = await query(
      'SELECT id FROM pick_lists WHERE medusa_order_id = $1',
      [medusaOrderId]
    );

    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: 'Pick list already exists for this order' });
    }

    // Generate pick list number (e.g., PL-20260818-0001)
    const datePrefix = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const counterResult = await query(
      `SELECT COUNT(*) as count FROM pick_lists 
       WHERE pick_list_number LIKE $1`,
      [`PL-${datePrefix}-%`]
    );
    const pickNumber = `PL-${datePrefix}-${String(counterResult.rows[0].count + 1).padStart(4, '0')}`;

    // Create pick list
    const result = await query(
      `INSERT INTO pick_lists (id, medusa_order_id, pick_list_number, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [uuidv4(), medusaOrderId, pickNumber, notes || null]
    );

    return res.status(201).json({
      pickList: result.rows[0],
      message: `Pick list ${pickNumber} created`,
    });
  } catch (error) {
    console.error('Pick list creation error:', error);
    return res.status(500).json({ error: 'Failed to create pick list' });
  }
});

/**
 * POST /api/pick-lists/:pickListId/items
 * Add an item to a pick list
 * 
 * Input: {
 *   lineNumber: 1,
 *   productSku: "H2910NL",
 *   colourCode: "BLK",
 *   quantityRequired: 5
 * }
 */
router.post('/:pickListId/items', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;
    const { lineNumber, productSku, colourCode, quantityRequired } = req.body;

    if (!lineNumber || !productSku || !quantityRequired) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await query(
      `INSERT INTO pick_list_items 
       (id, pick_list_id, line_number, product_sku, colour_code, quantity_required)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pick_list_id, line_number) 
       DO UPDATE SET product_sku = $4, colour_code = $5, quantity_required = $6
       RETURNING *`,
      [uuidv4(), pickListId, lineNumber, productSku, colourCode || null, quantityRequired]
    );

    return res.json({
      item: result.rows[0],
      message: `Added line ${lineNumber}: ${productSku}`,
    });
  } catch (error) {
    console.error('Pick item error:', error);
    return res.status(500).json({ error: 'Failed to add pick item' });
  }
});

/**
 * PATCH /api/pick-lists/:pickListId/items/:itemId/pick
 * Mark an item as picked (scan to confirm)
 * 
 * Input: {
 *   quantityPicked: 5,
 *   pickedFromLocationCode: "A1",
 *   notes?: "Item damaged, substituted with..."
 * }
 */
router.patch('/:pickListId/items/:itemId/pick', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId, itemId } = req.params;
    const { quantityPicked, pickedFromLocationCode, notes } = req.body;

    // Check if this is a sandbox pick list — skip real inventory updates if so
    const plCheck = await query(`SELECT is_sandbox FROM pick_lists WHERE id = $1`, [pickListId]);
    const isSandbox = plCheck.rows[0]?.is_sandbox ?? false;

    // Get location ID
    let locationId = null;
    if (pickedFromLocationCode) {
      const locResult = await query('SELECT id FROM warehouse_locations WHERE location_code = $1', [pickedFromLocationCode]);
      if (locResult.rows.length > 0) locationId = locResult.rows[0].id;
    }

    // Mark item as picked
    const result = await query(
      `UPDATE pick_list_items 
       SET status = 'PICKED', quantity_picked = $1, picked_from_location_id = $2,
           notes = $3, updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [quantityPicked, locationId, notes || null, itemId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Pick item not found' });

    // Reserve inventory — skip for sandbox lists to protect real stock
    if (!isSandbox && locationId && quantityPicked) {
      await query(
        `UPDATE warehouse_inventory 
         SET quantity_reserved = quantity_reserved + $1, updated_at = NOW()
         WHERE location_id = $2 AND product_sku = (SELECT product_sku FROM pick_list_items WHERE id = $3)`,
        [quantityPicked, locationId, itemId]
      );
    }

    return res.json({
      item: result.rows[0],
      sandbox: isSandbox,
      message: isSandbox ? `[Sandbox] Marked ${quantityPicked} units picked (no real stock change)` : `Picked ${quantityPicked} units`,
    });
  } catch (error) {
    console.error('Pick confirmation error:', error);
    return res.status(500).json({ error: 'Failed to confirm pick' });
  }
});

/**
 * PATCH /api/pick-lists/:pickListId/complete
 * Mark pick list as completed
 */
router.patch('/:pickListId/start', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;
    const result = await query(
      `UPDATE pick_lists SET status = 'IN_PROGRESS', updated_at = NOW()
       WHERE id = $1 AND status = 'PENDING' RETURNING *`,
      [pickListId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pick list not found or already started' });
    }
    return res.json({ pickList: result.rows[0] });
  } catch (error) {
    console.error('Pick list start error:', error);
    return res.status(500).json({ error: 'Failed to start pick list' });
  }
});

router.patch('/:pickListId/complete', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;
    const { notes } = req.body;

    const result = await query(
      `UPDATE pick_lists 
       SET status = 'PICKED', completed_at = NOW(), notes = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [notes || null, pickListId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pick list not found' });
    }

    return res.json({ pickList: result.rows[0], message: 'Pick list completed' });
  } catch (error) {
    console.error('Pick completion error:', error);
    return res.status(500).json({ error: 'Failed to complete pick list' });
  }
});

router.patch('/:pickListId/fulfilment-plan', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;
    const {
      selectedCourierCode,
      selectedServiceCode,
      shippingRequirements,
      parcelCount,
      packagingCostGbp,
      packingNotes,
      packages,
    } = req.body ?? {};

    const existing = await query(`SELECT id FROM pick_lists WHERE id = $1`, [pickListId]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Pick list not found' });

    await query(
      `UPDATE pick_lists
       SET selected_courier_code = COALESCE($1, selected_courier_code),
           selected_service_code = COALESCE($2, selected_service_code),
           shipping_requirements = CASE WHEN $3::jsonb IS NULL THEN shipping_requirements ELSE $3::jsonb END,
           parcel_count = COALESCE($4, parcel_count),
           packaging_cost_gbp = COALESCE($5, packaging_cost_gbp),
           packing_notes = COALESCE($6, packing_notes),
           updated_at = NOW()
       WHERE id = $7`,
      [
        selectedCourierCode ?? null,
        selectedServiceCode ?? null,
        shippingRequirements ? JSON.stringify(shippingRequirements) : null,
        parcelCount ?? null,
        packagingCostGbp ?? null,
        packingNotes ?? null,
        pickListId,
      ]
    );

    if (Array.isArray(packages)) {
      for (const pkg of packages) {
        const packageId = pkg.id || uuidv4();
        await query(
          `INSERT INTO pick_list_packages (
             id, pick_list_id, package_number, packaging_profile_code, courier_service_code,
             label_status, tracking_number, package_weight_grams, package_length_mm,
             package_width_mm, package_height_mm, package_cost_gbp, contents_summary,
             checklist_state, metadata, updated_at
           )
           VALUES (
             $1, $2, $3, $4, $5,
             COALESCE($6, 'NOT_PRINTED'), $7, $8, $9,
             $10, $11, COALESCE($12, 0), $13,
             COALESCE($14::jsonb, '[]'::jsonb), COALESCE($15::jsonb, '{}'::jsonb), NOW()
           )
           ON CONFLICT (pick_list_id, package_number)
           DO UPDATE SET packaging_profile_code = EXCLUDED.packaging_profile_code,
                         courier_service_code = EXCLUDED.courier_service_code,
                         label_status = EXCLUDED.label_status,
                         tracking_number = EXCLUDED.tracking_number,
                         package_weight_grams = EXCLUDED.package_weight_grams,
                         package_length_mm = EXCLUDED.package_length_mm,
                         package_width_mm = EXCLUDED.package_width_mm,
                         package_height_mm = EXCLUDED.package_height_mm,
                         package_cost_gbp = EXCLUDED.package_cost_gbp,
                         contents_summary = EXCLUDED.contents_summary,
                         checklist_state = EXCLUDED.checklist_state,
                         metadata = EXCLUDED.metadata,
                         updated_at = NOW()`,
          [
            packageId,
            pickListId,
            pkg.packageNumber,
            pkg.packagingProfileCode ?? null,
            pkg.courierServiceCode ?? null,
            pkg.labelStatus ?? null,
            pkg.trackingNumber ?? null,
            pkg.packageWeightGrams ?? null,
            pkg.packageLengthMm ?? null,
            pkg.packageWidthMm ?? null,
            pkg.packageHeightMm ?? null,
            pkg.packageCostGbp ?? null,
            pkg.contentsSummary ?? null,
            pkg.checklistState ? JSON.stringify(pkg.checklistState) : null,
            pkg.metadata ? JSON.stringify(pkg.metadata) : null,
          ]
        );
      }
    }

    return res.json({ success: true, message: 'Fulfilment plan updated' });
  } catch (error) {
    console.error('Fulfilment plan update error:', error);
    return res.status(500).json({ error: 'Failed to update fulfilment plan' });
  }
});

router.patch('/:pickListId/packing/start', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;
    const result = await query(
      `UPDATE pick_lists
       SET status = 'PACKING',
           packing_started_at = COALESCE(packing_started_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND status IN ('PICKED', 'IN_PROGRESS')
       RETURNING *`,
      [pickListId]
    );
    if (!result.rows[0]) return res.status(400).json({ error: 'Pick list must be picked before packing starts' });
    return res.json({ pickList: result.rows[0] });
  } catch (error) {
    console.error('Packing start error:', error);
    return res.status(500).json({ error: 'Failed to start packing' });
  }
});

router.patch('/:pickListId/packing/complete', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;
    const { packagingCostGbp, parcelCount, packingNotes } = req.body ?? {};
    const result = await query(
      `UPDATE pick_lists
       SET status = 'PACKED',
           packed_at = NOW(),
           packaging_cost_gbp = COALESCE($1, packaging_cost_gbp),
           parcel_count = COALESCE($2, parcel_count),
           packing_notes = COALESCE($3, packing_notes),
           updated_at = NOW()
       WHERE id = $4 AND status IN ('PACKING', 'PICKED')
       RETURNING *`,
      [packagingCostGbp ?? null, parcelCount ?? null, packingNotes ?? null, pickListId]
    );
    if (!result.rows[0]) return res.status(400).json({ error: 'Pick list must be in packing before completion' });
    return res.json({ pickList: result.rows[0] });
  } catch (error) {
    console.error('Packing completion error:', error);
    return res.status(500).json({ error: 'Failed to complete packing' });
  }
});

router.patch('/:pickListId/label-printed', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;
    const result = await query(
      `UPDATE pick_lists
       SET label_printed_at = NOW(),
           status = CASE WHEN status IN ('PACKED', 'PACKING', 'PICKED') THEN 'LABEL_PRINTED' ELSE status END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [pickListId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Pick list not found' });
    return res.json({ pickList: result.rows[0] });
  } catch (error) {
    console.error('Label printed update error:', error);
    return res.status(500).json({ error: 'Failed to update label status' });
  }
});

/**
 * PATCH /api/pick-lists/:pickListId/dispatch
 * Mark pick list as dispatched (items have physically left the warehouse).
 * Decrements warehouse_inventory.quantity, clears reservations, pushes to Medusa.
 * This is the only point where physical stock numbers change on outbound.
 */
router.patch('/:pickListId/dispatch', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;

    const pickList = await query(`SELECT * FROM pick_lists WHERE id = $1`, [pickListId]);
    if (!pickList.rows[0]) return res.status(404).json({ error: 'Pick list not found' });
    if (!['PICKED', 'IN_PROGRESS', 'PACKING', 'PACKED', 'LABEL_PRINTED'].includes(pickList.rows[0].status)) {
      return res.status(400).json({ error: 'Pick list must be picked or packed before dispatch' });
    }

    // Get all picked items
    const items = await query(
      `SELECT pli.*, wi.location_id as inv_location_id
       FROM pick_list_items pli
       LEFT JOIN warehouse_inventory wi
         ON wi.product_sku = pli.product_sku
         AND wi.location_id = pli.picked_from_location_id
       WHERE pli.pick_list_id = $1 AND pli.quantity_picked > 0`,
      [pickListId]
    );

    const syncSkus = new Set<string>();

    for (const item of items.rows) {
      const sku = item.product_sku;
      const qty = parseInt(item.quantity_picked);
      const locationId = item.picked_from_location_id;
      if (!sku || !qty || !locationId) continue;

      // Decrement physical stock and clear the reservation
      await query(
        `UPDATE warehouse_inventory
         SET quantity = GREATEST(quantity - $1, 0),
             quantity_reserved = GREATEST(quantity_reserved - $1, 0),
             updated_at = NOW()
         WHERE product_sku = $2 AND location_id = $3`,
        [qty, sku, locationId]
      );
      syncSkus.add(sku);
    }

    // Mark pick list as dispatched
    await query(
      `UPDATE pick_lists SET status = 'DISPATCHED', dispatched_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [pickListId]
    );

    // Push new WMS totals to Medusa for all affected SKUs
    const syncErrors: string[] = [];
    for (const sku of syncSkus) {
      const totalResult = await query(
        `SELECT SUM(quantity) as qty, SUM(quantity_reserved) as reserved FROM warehouse_inventory WHERE product_sku = $1`,
        [sku]
      );
      const newTotal = Math.max(0, parseInt(totalResult.rows[0]?.qty ?? '0') - parseInt(totalResult.rows[0]?.reserved ?? '0'));
      const result = await syncSkuToMedusa(sku, newTotal);
      if (!result.ok) syncErrors.push(`${sku}: ${result.error}`);
    }

    res.json({
      success: true,
      dispatched: items.rows.length,
      skus_synced: syncSkus.size - syncErrors.length,
      sync_errors: syncErrors.length > 0 ? syncErrors : undefined,
    });
  } catch (error) {
    console.error('Pick list dispatch error:', error);
    res.status(500).json({ error: 'Failed to dispatch pick list' });
  }
});

/** DELETE /api/pick-lists/:pickListId — cancel a pending or in-progress pick list */
router.delete('/:pickListId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { pickListId } = req.params;
    const existing = await query(`SELECT status FROM pick_lists WHERE id = $1`, [pickListId]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Pick list not found' });
    if (existing.rows[0].status === 'PICKED') {
      return res.status(400).json({ error: 'Cannot cancel a completed pick list' });
    }
    await query(
      `UPDATE pick_lists SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1`,
      [pickListId]
    );
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to cancel pick list' });
  }
});

export default router;
