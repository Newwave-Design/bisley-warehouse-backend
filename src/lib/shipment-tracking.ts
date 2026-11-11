import { query } from '../db/index.js';
import { fetchDxTrackingNumbers } from './dx-freight.js';
import { saveMedusaShipment } from './medusa-fulfillment.js';
import { rootMedusaOrderId } from './order-values.js';

/**
 * Customer tracking for a shipped order.
 * APC's live page reads the 22-digit consignment id. The older track-parcel.php
 * address now redirects away and drops the number.
 * DX Freight tracking reads the consignment (a letter plus 7 digits, or 8 digits)
 * and the delivery postcode with the space removed. The box barcode is that
 * consignment plus a piece suffix, and the old my.dxdelivery.com query does not
 * open it.
 */

type Piece = { trackingNumber?: string; [key: string]: unknown };

export type StoredTracking = {
  number: string;
  url: string;
};

type BookingRow = {
  id: string;
  status: string;
  tracking_number: string | null;
  tracking_url: string | null;
  medusa_order_id: string | null;
  medusa_fulfillment_id: string | null;
  is_sandbox: boolean;
  courier: string;
  waybill: string | null;
  delivery_postcode: string | null;
  apc_order_number: string | null;
  pieces: Piece[] | null;
};

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function compactPostcode(value: string): string {
  return value.toUpperCase().replace(/\s+/g, '');
}

export function apcCustomerTracking(waybill: string): StoredTracking | null {
  const number = waybill.replace(/\s+/g, '');
  if (!/^\d{22}$/.test(number)) return null;
  return {
    number,
    url: `https://apcchoice.apc-overnight.com/track-parcel?id=${number}`,
  };
}

export function dxCustomerTracking(consignment: string, postcode: string): StoredTracking | null {
  const number = consignment.replace(/\s+/g, '').toUpperCase();
  const tpc = compactPostcode(postcode);
  if (!/^[A-Z]\d{7}$|^\d{8}$/.test(number) || tpc.length < 5) return null;
  return {
    number,
    url: `https://dx-track.com/track/dx.aspx?consno=${encodeURIComponent(number)}&postcode=${encodeURIComponent(tpc)}`,
  };
}

function dxConsignment(waybill: string, pieceNumber: string): string {
  const stored = waybill.replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z]\d{7}$|^\d{8}$/.test(stored)) return stored;
  const piece = pieceNumber.replace(/\s+/g, '').toUpperCase();
  const fromPiece = piece.slice(0, 8);
  return /^[A-Z]\d{7}$|^\d{8}$/.test(fromPiece) ? fromPiece : '';
}

function pieceNumbers(pieces: Piece[] | null): string[] {
  return (Array.isArray(pieces) ? pieces : [])
    .map((piece) => text(piece?.trackingNumber))
    .filter(Boolean);
}

function withPieceNumbers(pieces: Piece[] | null, numbers: string[]): Piece[] | null {
  if (!Array.isArray(pieces) || !numbers.length) return null;
  let changed = false;
  const next = pieces.map((piece, index) => {
    if (text(piece?.trackingNumber) || !numbers[index]) return piece;
    changed = true;
    return { ...piece, trackingNumber: numbers[index] };
  });
  return changed ? next : null;
}

function trackingFor(row: BookingRow, fetched: string[]): StoredTracking | null {
  const courier = text(row.courier).toUpperCase();
  const waybill = text(row.waybill);
  const numbers = fetched.length ? fetched : pieceNumbers(row.pieces);
  if (courier === 'APC') return apcCustomerTracking(waybill);
  if (courier === 'DX') return dxCustomerTracking(dxConsignment(waybill, numbers[0] || ''), text(row.delivery_postcode));
  return null;
}

function needsPieceNumbers(row: BookingRow): boolean {
  const pieces = Array.isArray(row.pieces) ? row.pieces : [];
  return pieces.length > 0 && pieces.some((piece) => !text(piece?.trackingNumber));
}

async function fetchApcPieceNumbers(waybill: string): Promise<string[]> {
  const user = process.env.APC_USER;
  const password = process.env.APC_PASSWORD;
  if (!user || !password || !/^\d{22}$/.test(waybill)) return [];
  const remoteUser = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const url = `https://apc.hypaship.com/api/3.0/Tracks/${encodeURIComponent(waybill)}.json?searchtype=CarrierWaybill&history=No`;
  const response = await fetch(url, { headers: { 'remote-user': remoteUser, Accept: 'application/json' } });
  if (!response.ok) return [];
  const payload = await response.json() as { Tracks?: { Track?: any; Messages?: { Code?: string } } };
  const code = text(payload?.Tracks?.Messages?.Code).toUpperCase();
  if (code && !['SUCCESS', 'OK', '0', '00'].includes(code)) return [];
  const track = payload?.Tracks?.Track;
  const row = Array.isArray(track) ? track[0] : track;
  const wrapped = row?.ShipmentDetails?.Items;
  const groups = Array.isArray(wrapped) ? wrapped : wrapped ? [wrapped] : [];
  return groups.flatMap((group) => {
    const item = group?.Item || group;
    const list = Array.isArray(item) ? item : item ? [item] : [];
    return list.map((piece) => text(piece?.TrackingNumber)).filter(Boolean);
  });
}

async function missingNumbers(row: BookingRow): Promise<string[]> {
  if (!needsPieceNumbers(row)) return [];
  const courier = text(row.courier).toUpperCase();
  const waybill = text(row.waybill);
  try {
    if (courier === 'APC') return await fetchApcPieceNumbers(waybill);
    if (courier === 'DX') return await fetchDxTrackingNumbers(waybill, text(row.apc_order_number) || 'F');
  } catch (error) {
    console.warn(`[tracking] ${courier} ${waybill}:`, error instanceof Error ? error.message : 'no tracking number yet');
  }
  return [];
}

async function attachMedusaLabel(row: BookingRow, tracking: StoredTracking) {
  // The shop shipment for APC and DX is sent when the carrier scan says the parcel is on its way.
  if (text(row.courier).toUpperCase() === 'APC' || text(row.courier).toUpperCase() === 'DX') return;
  if (row.is_sandbox || row.status !== 'DISPATCHED' || !row.medusa_fulfillment_id || !row.medusa_order_id) return;
  if (!row.medusa_order_id.startsWith('order_')) return;
  try {
    await saveMedusaShipment(rootMedusaOrderId(row.medusa_order_id), row.medusa_fulfillment_id, tracking.number, tracking.url);
  } catch (error) {
    console.warn(
      `[tracking] Medusa label for ${row.id}:`,
      error instanceof Error ? error.message : 'not saved'
    );
  }
}

/** Fill tracking number and customer link for orders that have a collection but not both details yet. */
export async function rememberShipmentTracking(pickListId?: string): Promise<{ filled: number; waiting: number }> {
  const params: string[] = [];
  const onlyOne = pickListId ? (params.push(pickListId), 'AND pl.id = $1') : '';
  const found = await query(
    `SELECT DISTINCT ON (pl.id)
            pl.id, pl.status, pl.tracking_number, pl.tracking_url,
            pl.medusa_order_id, pl.medusa_fulfillment_id, pl.is_sandbox,
            b.courier, b.waybill, b.delivery_postcode, b.apc_order_number, b.pieces
     FROM pick_lists pl
     JOIN collection_bookings b ON b.pick_list_id = pl.id AND b.status <> 'cancelled' AND COALESCE(b.direction, 'outbound') <> 'return'
     WHERE NOT pl.is_archived
       AND pl.status <> 'CANCELLED'
       AND b.courier IN ('APC', 'DX')
       ${onlyOne}
       AND (
         COALESCE(btrim(pl.tracking_url), '') = ''
         OR COALESCE(btrim(pl.tracking_number), '') = ''
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(b.pieces, '[]'::jsonb)) piece
           WHERE COALESCE(piece->>'trackingNumber', '') = ''
         )
       )
     ORDER BY pl.id, b.created_at DESC`,
    params
  );

  let filled = 0;
  let waiting = 0;
  for (const row of found.rows as BookingRow[]) {
    const fetched = await missingNumbers(row);
    const pieces = withPieceNumbers(row.pieces, fetched);
    if (pieces) {
      await query(
        `UPDATE collection_bookings
            SET pieces = $1::jsonb, updated_at = NOW()
          WHERE pick_list_id = $2 AND waybill = $3 AND status <> 'cancelled'`,
        [JSON.stringify(pieces), row.id, text(row.waybill)]
      );
      row.pieces = pieces;
    }
    const tracking = trackingFor(row, fetched);
    if (!tracking) {
      waiting += 1;
      continue;
    }
    const sameNumber = text(row.tracking_number) === tracking.number;
    const sameUrl = text(row.tracking_url) === tracking.url;
    if (!sameNumber || !sameUrl) {
      await query(
        `UPDATE pick_lists
            SET tracking_number = $1, tracking_url = $2, carrier = $3, updated_at = NOW()
          WHERE id = $4`,
        [tracking.number, tracking.url, text(row.courier).toUpperCase(), row.id]
      );
      filled += 1;
      if (!sameUrl) await attachMedusaLabel(row, tracking);
    }
  }
  return { filled, waiting };
}
