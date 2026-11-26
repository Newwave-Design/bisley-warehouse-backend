/**
 * Insert-tray singles and 5-packs are one pool of trays, so each SKU shows what can be sold as that form.
 * A single counts its own stock plus five for every pack. A pack counts its own stock plus one for every five singles.
 * Stock is still held as scanned in; this only works out the figure shown or sent to the shop.
 */
import { TRAYS_PER_PACK, trayForm } from './tray-stock.js';
import { packBase, packSkuFor, singleBase, singleSkuForBase } from './tray-pack.js';

/** The other form of the same tray (`225P1-000` <-> `225P5-000`), or null when the SKU is not an insert tray. */
export function trayMate(sku: string): string | null {
  const code = String(sku || '').trim();
  const pack = packBase(code);
  if (pack) return singleSkuForBase(pack);
  const single = singleBase(code);
  if (single) return packSkuFor(single);
  return null;
}

/** What can be sold as this SKU's form, given its own count and the other form's count. Other products keep their own count. */
export function pooledTrayQty(sku: string, own: number, mate: number): number {
  const form = trayForm(sku);
  if (!form) return own;
  const other = Math.max(0, Math.trunc(mate) || 0);
  return form === 'single' ? own + other * TRAYS_PER_PACK : own + Math.floor(other / TRAYS_PER_PACK);
}
