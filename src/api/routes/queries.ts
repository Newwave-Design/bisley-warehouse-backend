/**
 * Customer Queries & CRM API Routes
 * Handles customer inquiry management, communication history, and action tracking
 * Routes: GET/POST /queries, GET/PUT /queries/:id, POST /queries/:id/records, POST /queries/:id/actions
 * Requires: manage_crm permission
 */

import express, { Request, Response } from 'express'
import { v4 as uuid } from 'uuid'
import pool from '../../db/index.js'
import type { PoolClient } from 'pg'

const router = express.Router()

/**
 * GET /api/queries
 * List all customer queries with filtering, sorting, pagination
 * Query params: status, priority, search, assigned_to, sort_by, page, limit
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { status, priority, search, assigned_to, sort_by = 'created_at', page = 1, limit = 50 } = req.query
    const offset = ((Number(page) - 1) * Number(limit))

    let query = `
      SELECT 
        q.id, q.query_number, q.customer_name, q.customer_email, q.subject, 
        q.status, q.priority, q.assigned_to, q.created_at, q.updated_at,
        au.name as assigned_to_name,
        COUNT(DISTINCT qr.id) as record_count,
        COUNT(DISTINCT qa.id) as action_count
      FROM customer_queries q
      LEFT JOIN warehouse_users au ON q.assigned_to = au.id
      LEFT JOIN query_records qr ON q.id = qr.query_id
      LEFT JOIN query_actions qa ON q.id = qa.query_id
      WHERE 1=1
    `
    const params: any[] = []

    if (status) {
      query += ` AND q.status = $${params.length + 1}`
      params.push(status)
    }
    if (priority) {
      query += ` AND q.priority = $${params.length + 1}`
      params.push(priority)
    }
    if (assigned_to) {
      query += ` AND q.assigned_to = $${params.length + 1}`
      params.push(assigned_to)
    }
    if (search) {
      query += ` AND (q.customer_name ILIKE $${params.length + 1} OR q.customer_email ILIKE $${params.length + 1} OR q.subject ILIKE $${params.length + 1})`
      const searchTerm = `%${search}%`
      params.push(searchTerm, searchTerm, searchTerm)
    }

    query += ` GROUP BY q.id, au.id ORDER BY q.${sort_by} DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(limit, offset)

    const result = await pool.query(query, params)
    res.json({ queries: result.rows, total: result.rows.length })
  } catch (error) {
    console.error('Error fetching queries:', error)
    res.status(500).json({ error: 'Failed to fetch queries' })
  }
})

/**
 * POST /api/queries
 * Create a new customer query
 * Body: { customer_name, customer_email, customer_phone, subject, description, priority, assigned_to }
 */
router.post('/', async (req: Request, res: Response) => {
  const client: PoolClient | undefined = await pool.connect()
  try {
    const { customer_name, customer_email, customer_phone, subject, description, priority = 'normal', assigned_to } = req.body
    const user_id = (req as any).user?.id

    if (!customer_name || !subject) {
      res.status(400).json({ error: 'customer_name and subject are required' })
      return
    }

    const query_number = `Q-${Date.now()}`
    const query_id = uuid()

    const result = await client!.query(
      `INSERT INTO customer_queries (id, query_number, customer_name, customer_email, customer_phone, subject, description, status, priority, assigned_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10)
       RETURNING *`,
      [query_id, query_number, customer_name, customer_email, customer_phone, subject, description, priority, assigned_to || null, user_id]
    )

    res.status(201).json(result.rows[0])
  } catch (error) {
    console.error('Error creating query:', error)
    res.status(500).json({ error: 'Failed to create query' })
  } finally {
    client?.release()
  }
})

/**
 * GET /api/queries/:id
 * Fetch a single query with full detail: records, linked orders, actions
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params

    const queryResult = await pool.query(
      `SELECT q.*, 
              au.name as assigned_to_name,
              u.email as created_by_email
       FROM customer_queries q
       LEFT JOIN warehouse_users au ON q.assigned_to = au.id
       LEFT JOIN warehouse_users u ON q.created_by = u.id
       WHERE q.id = $1`,
      [id]
    )

    if (queryResult.rows.length === 0) {
      res.status(404).json({ error: 'Query not found' })
      return
    }

    const query = queryResult.rows[0]

    // Fetch records (communication history)
    const recordsResult = await pool.query(
      `SELECT qr.*, u.name as created_by_name
       FROM query_records qr
       LEFT JOIN warehouse_users u ON qr.created_by = u.id
       WHERE qr.query_id = $1
       ORDER BY qr.created_at DESC`,
      [id]
    )

    // Fetch linked orders
    const ordersResult = await pool.query(
      `SELECT * FROM query_linked_orders WHERE query_id = $1 ORDER BY tagged_at DESC`,
      [id]
    )

    // Fetch actions
    const actionsResult = await pool.query(
      `SELECT qa.*, u.name as created_by_name
       FROM query_actions qa
       LEFT JOIN warehouse_users u ON qa.created_by = u.id
       WHERE qa.query_id = $1
       ORDER BY qa.created_at DESC`,
      [id]
    )

    res.json({
      ...query,
      records: recordsResult.rows,
      linked_orders: ordersResult.rows,
      actions: actionsResult.rows
    })
  } catch (error) {
    console.error('Error fetching query detail:', error)
    res.status(500).json({ error: 'Failed to fetch query' })
  }
})

/**
 * PUT /api/queries/:id
 * Update a query (status, priority, assignment, description)
 */
router.put('/:id', async (req: Request, res: Response) => {
  const client: PoolClient | undefined = await pool.connect()
  try {
    const { id } = req.params
    const { status, priority, assigned_to, description, subject } = req.body

    let updateQuery = 'UPDATE customer_queries SET '
    const params: any[] = []
    const updates: string[] = []

    if (status) {
      updates.push(`status = $${params.length + 1}`)
      params.push(status)
    }
    if (priority) {
      updates.push(`priority = $${params.length + 1}`)
      params.push(priority)
    }
    if (assigned_to !== undefined) {
      updates.push(`assigned_to = $${params.length + 1}`)
      params.push(assigned_to || null)
    }
    if (description !== undefined) {
      updates.push(`description = $${params.length + 1}`)
      params.push(description)
    }
    if (subject) {
      updates.push(`subject = $${params.length + 1}`)
      params.push(subject)
    }

    updates.push(`updated_at = NOW()`)
    updateQuery += updates.join(', ')
    updateQuery += ` WHERE id = $${params.length + 1} RETURNING *`
    params.push(id)

    const result = await client!.query(updateQuery, params)

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Query not found' })
      return
    }

    res.json(result.rows[0])
  } catch (error) {
    console.error('Error updating query:', error)
    res.status(500).json({ error: 'Failed to update query' })
  } finally {
    client?.release()
  }
})

/**
 * GET /api/queries/:id/matching-orders
 * Auto-fetch relevant pick lists and customer orders based on customer email/name
 * Returns: pick_lists matching email, and any unlinked customer orders
 */
router.get('/:id/matching-orders', async (req: Request, res: Response) => {
  try {
    const { id } = req.params

    // Get the query to extract customer info
    const queryResult = await pool.query(
      `SELECT customer_name, customer_email FROM customer_queries WHERE id = $1`,
      [id]
    )

    if (queryResult.rows.length === 0) {
      res.status(404).json({ error: 'Query not found' })
      return
    }

    const { customer_name, customer_email } = queryResult.rows[0]

    // Find matching pick lists
    const pickListsResult = await pool.query(
      `SELECT pl.id, pl.pick_list_number, pl.medusa_order_id, pl.customer_name, pl.status, pl.created_at
       FROM pick_lists pl
       WHERE (pl.customer_email = $1 OR pl.customer_name ILIKE $2)
       AND pl.status NOT IN ('DISPATCHED', 'CANCELLED')
       LIMIT 20`,
      [customer_email, `%${customer_name}%`]
    )

    // Get already-linked orders for this query
    const linkedResult = await pool.query(
      `SELECT pick_list_id, medusa_order_id FROM query_linked_orders WHERE query_id = $1`,
      [id]
    )
    const linkedOrderIds = new Set(linkedResult.rows.map((r: any) => r.pick_list_id || r.medusa_order_id))

    const matching_orders = pickListsResult.rows.filter((row: any) => !linkedOrderIds.has(row.id))

    res.json({ matching_orders })
  } catch (error) {
    console.error('Error fetching matching orders:', error)
    res.status(500).json({ error: 'Failed to fetch matching orders' })
  }
})

/**
 * POST /api/queries/:id/records
 * Add a communication record (note, action log, etc.)
 * Body: { record_type, record_title, content, record_value }
 */
router.post('/:id/records', async (req: Request, res: Response) => {
  const client: PoolClient | undefined = await pool.connect()
  try {
    const { id } = req.params
    const { record_type, record_title, content, record_value } = req.body
    const user_id = (req as any).user?.id

    if (!record_type || !content) {
      res.status(400).json({ error: 'record_type and content are required' })
      return
    }

    const result = await client!.query(
      `INSERT INTO query_records (id, query_id, record_type, record_title, content, record_value, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [uuid(), id, record_type, record_title || null, content, record_value || null, user_id]
    )

    // Update query's updated_at timestamp
    await client!.query(
      `UPDATE customer_queries SET updated_at = NOW() WHERE id = $1`,
      [id]
    )

    res.status(201).json(result.rows[0])
  } catch (error) {
    console.error('Error creating record:', error)
    res.status(500).json({ error: 'Failed to create record' })
  } finally {
    client?.release()
  }
})

/**
 * POST /api/queries/:id/actions
 * Create a query action (refund, return, cancel)
 * Body: { action_type, action_value, action_description, linked_pick_list_id }
 */
router.post('/:id/actions', async (req: Request, res: Response) => {
  const client: PoolClient | undefined = await pool.connect()
  try {
    const { id } = req.params
    const { action_type, action_value, action_description, linked_pick_list_id } = req.body
    const user_id = (req as any).user?.id

    if (!action_type) {
      res.status(400).json({ error: 'action_type is required' })
      return
    }

    const result = await client!.query(
      `INSERT INTO query_actions (id, query_id, action_type, action_value, action_description, linked_pick_list_id, created_by, medusa_sync_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING *`,
      [uuid(), id, action_type, action_value || null, action_description || null, linked_pick_list_id || null, user_id]
    )

    // Update query's updated_at timestamp
    await client!.query(
      `UPDATE customer_queries SET updated_at = NOW() WHERE id = $1`,
      [id]
    )

    res.status(201).json(result.rows[0])
  } catch (error) {
    console.error('Error creating action:', error)
    res.status(500).json({ error: 'Failed to create action' })
  } finally {
    client?.release()
  }
})

/**
 * POST /api/queries/:id/link-order
 * Link a pick list or Medusa order to a query
 * Body: { pick_list_id, medusa_order_id, order_status, order_value_gbp }
 */
router.post('/:id/link-order', async (req: Request, res: Response) => {
  const client: PoolClient | undefined = await pool.connect()
  try {
    const { id } = req.params
    const { pick_list_id, medusa_order_id, order_status, order_value_gbp, customer_name_on_order } = req.body

    if (!pick_list_id && !medusa_order_id) {
      res.status(400).json({ error: 'pick_list_id or medusa_order_id is required' })
      return
    }

    const result = await client!.query(
      `INSERT INTO query_linked_orders (id, query_id, pick_list_id, medusa_order_id, customer_name_on_order, order_value_gbp, order_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (query_id, pick_list_id, medusa_order_id) DO UPDATE SET tagged_at = NOW()
       RETURNING *`,
      [uuid(), id, pick_list_id || null, medusa_order_id || null, customer_name_on_order, order_value_gbp || null, order_status]
    )

    res.status(201).json(result.rows[0])
  } catch (error) {
    console.error('Error linking order:', error)
    res.status(500).json({ error: 'Failed to link order' })
  } finally {
    client?.release()
  }
})

export default router
