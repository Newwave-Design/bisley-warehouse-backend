/**
 * SGK Distribution (home delivery). SGK has no booking API: an order is queued here, and SGK is sent a
 * spreadsheet in their Order_Upload_Template layout.
 *
 * Rules from SGK's notes:
 *  - Order_No is 6 digits and the same on every row of an order, with the OV suffix.
 *  - Retailer never changes.
 *  - Order_Type is "delivery" or "pick up".
 *  - Order_Notes stays blank. Anything the driver needs (leave in a safe space, room of choice) is Driver_Notes.
 *  - Item_Code is the SKU. A SKU with more than one carton, such as a MultiDesk, shows the quantity.
 */

export const SGK_RETAILER = 'OVARA000000000001';
export const SGK_EMAIL = 'operations@sgkdistribution.co.uk';

export const SGK_COLUMNS = [
  'Order_No', 'Cust_Ord_No', 'Order_Date', 'Retailer', 'Order_Type', 'Del_Name',
  'Del_Addr_1', 'Del_Addr_2', 'Del_Addr_3', 'Del_Town', 'Postal_Code',
  'Contact_Tel_1', 'Contact_Tel_2', 'Contact_Tel_Mob', 'Contact_Email',
  'Order_Notes', 'Driver_Notes', 'Service_Lv', 'Assy_Time', 'Unload_Time', 'Delivery_Method',
  'Item_Code', 'Item_Desc', 'Item_Qty', 'Item_Wgt', 'Item_Cube',
] as const;

export type SgkColumn = typeof SGK_COLUMNS[number];
export type SgkRow = Record<SgkColumn, string>;

export interface SgkPiece {
  sku?: string | null;
  itemSku?: string | null;
  title?: string | null;
  reference?: string | null;
  /** Packed weight of this carton in kg. */
  weightKg?: string | number | null;
}

export interface SgkConsignment {
  /** Shop order number from the pick list number, e.g. PL-20261001-0161 is 161. */
  pickListNumber: string;
  orderDate: Date | string | null;
  customerName: string;
  email: string;
  phone: string;
  shippingAddress: Record<string, unknown> | null;
  driverNotes: string;
  orderType?: 'delivery' | 'pick up';
  pieces: SgkPiece[];
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

/** The number in the pick list number, without leading zeros. Empty when there is none. */
export function shopOrderNumber(pickListNumber: string): string {
  const match = text(pickListNumber).match(/^PL-\d{8}-(\d+)/i);
  return match ? String(parseInt(match[1], 10)) : '';
}

/** 6 digits then OV: order 161 is 000161OV. */
export function sgkOrderNo(pickListNumber: string): string {
  const number = shopOrderNumber(pickListNumber);
  if (!number) return '';
  return `${number.padStart(6, '0').slice(-6)}OV`;
}

/** dd/mm/yyyy in London, which is how the template reads a date. */
export function sgkDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${read('day')}/${read('month')}/${read('year')}`;
}

/** UK phone numbers: a mobile goes in the mobile column, anything else in Tel 1. */
export function sgkPhones(value: string): { tel1: string; mobile: string } {
  let digits = text(value).replace(/[^\d+]/g, '');
  if (digits.startsWith('+44')) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('0044')) digits = `0${digits.slice(4)}`;
  else if (/^44\d{10}$/.test(digits)) digits = `0${digits.slice(2)}`;
  digits = digits.replace(/\D/g, '');
  if (!digits) return { tel1: '', mobile: '' };
  return digits.startsWith('07') ? { tel1: '', mobile: digits } : { tel1: digits, mobile: '' };
}

/**
 * One row per SKU in the consignment. The pieces are the cartons the desk planned for the order, with the same merging
 * rules as an APC or DX booking (handles ride in the cabinet carton, a castor base in the multidrawer carton). Cartons
 * that share a SKU are one row with the count, in the order they were planned.
 */
/** Kilograms to one decimal place, without a trailing .0. */
export function formatKg(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * One row per SKU. The weight is the whole row's: every carton on it added together, so four cartons of 5 kg are 20.
 * A row where any carton has no weight has none, rather than a total that is too low.
 */
export function unitType(sku: string): string {
  const code = text(sku).toUpperCase();
  const dash = code.lastIndexOf('-');
  return dash > 0 ? code.slice(0, dash) : code;
}

export function sgkItems(pieces: SgkPiece[]): { code: string; desc: string; qty: number; weightKg: string }[] {
  const rows = new Map<string, { code: string; titles: string[]; qty: number; kg: number; unknown: boolean }>();
  for (const piece of pieces) {
    const code = text(piece.itemSku) || text(piece.sku) || text(piece.reference);
    const title = text(piece.title);
    // A row is one type of unit, whatever the colour: BA3-av1 and BA3-bn6 share a row (the SKU before the colour code).
    const key = code ? unitType(code) : title;
    if (!key) continue;
    const kg = Number(text(piece.weightKg));
    const known = Number.isFinite(kg) && kg > 0;
    const row = rows.get(key);
    if (row) {
      row.qty += 1;
      row.titles.push(title);
      if (known) row.kg += kg;
      else row.unknown = true;
    } else rows.set(key, { code, titles: [title], qty: 1, kg: known ? kg : 0, unknown: !known });
  }
  return [...rows.values()].map((row) => {
    // The desk numbers repeated cartons ("Pair of legs 1", "Pair of legs 2"). Identical titles are left as they are.
    const numbered = new Set(row.titles).size > 1;
    return { code: row.code, desc: numbered ? row.titles[0].replace(/\s+\d+$/, '') : row.titles[0], qty: row.qty, weightKg: row.unknown ? '' : formatKg(row.kg) };
  });
}

/** Said to the SGK driver on every row, ahead of anything written for that order. */
export const SGK_DRIVER_NOTES = 'Hallway delivery';

/** Extra delivery services an order can be tagged with. None are tagged yet, so every order is a hallway delivery. */
export interface SgkServices {
  roomOfChoice?: boolean;
  takePackagingAway?: boolean;
  packagingInspection?: boolean;
}

/**
 * Driver notes for an order: "Hallway delivery" by default, or room of choice when tagged, plus taking the
 * packaging away and a packaging inspection when tagged; then the order's own note, on one line.
 */
export function sgkDriverNotes(own: unknown, services: SgkServices = {}): string {
  const parts = [services.roomOfChoice ? 'Room of choice' : SGK_DRIVER_NOTES];
  if (services.takePackagingAway) parts.push('take packaging away');
  if (services.packagingInspection) parts.push('packaging inspection');
  const standard = parts.join(', ');
  const note = text(own).replace(/\s*[\r\n]+\s*/g, ' ');
  return note ? `${standard}. ${note}` : standard;
}

/** Order_Date is the day the list goes to SGK (the export day), not the day the customer ordered. */
export function sgkRows(consignment: SgkConsignment, exportedAt: Date = new Date()): SgkRow[] {
  const address = (consignment.shippingAddress || {}) as Record<string, unknown>;
  const person = text(`${text(address.first_name)} ${text(address.last_name)}`) || text(consignment.customerName);
  const company = text(address.company);
  const lines = [text(address.address_1), text(address.address_2)].filter(Boolean);
  if (company && company.toLowerCase() !== person.toLowerCase()) lines.unshift(company);
  const phones = sgkPhones(text(address.phone) || consignment.phone);
  const base: SgkRow = {
    Order_No: sgkOrderNo(consignment.pickListNumber),
    Cust_Ord_No: '',
    Order_Date: sgkDate(exportedAt),
    Retailer: SGK_RETAILER,
    Order_Type: consignment.orderType || 'delivery',
    Del_Name: person,
    Del_Addr_1: lines[0] || '',
    Del_Addr_2: lines[1] || '',
    Del_Addr_3: lines[2] || '',
    Del_Town: [text(address.city), text(address.province)].filter(Boolean).join(', '),
    Postal_Code: text(address.postal_code).toUpperCase(),
    Contact_Tel_1: phones.tel1,
    Contact_Tel_2: '',
    Contact_Tel_Mob: phones.mobile,
    Contact_Email: text(consignment.email) || text(address.email),
    Order_Notes: '',
    Driver_Notes: sgkDriverNotes(consignment.driverNotes),
    Service_Lv: '',
    Assy_Time: '',
    Unload_Time: '',
    Delivery_Method: '',
    Item_Code: '',
    Item_Desc: '',
    Item_Qty: '',
    Item_Wgt: '',
    Item_Cube: '',
  };
  const items = sgkItems(consignment.pieces);
  if (!items.length) return [base];
  return items.map((item) => ({ ...base, Item_Code: item.code, Item_Desc: item.desc, Item_Qty: String(item.qty), Item_Wgt: item.weightKg }));
}

/** Quote a field when it holds a comma, a quote or a line break. Leading = + - @ are kept as text for spreadsheets. */
function csvField(value: string): string {
  const safe = /^[=+\-@]/.test(value) && !/^[+\-]?\d[\d\s.]*$/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function sgkCsv(rows: SgkRow[]): string {
  const lines = [SGK_COLUMNS.join(',')];
  for (const row of rows) lines.push(SGK_COLUMNS.map((column) => csvField(row[column] ?? '')).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
