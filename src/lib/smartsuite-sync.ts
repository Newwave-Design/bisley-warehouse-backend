/**
 * Pulls the packaging tables from SmartSuite and runs the snapshot import on them.
 * Read only against SmartSuite. Writes only through importPackagingSnapshot.
 * Needs SMARTSUITE_API_KEY. SMARTSUITE_ACCOUNT_ID defaults to Bisley's workspace.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { importPackagingSnapshot } from './packaging-import.js';

const API = 'https://app.smartsuite.com/api/v1/applications/';
const DEFAULT_ACCOUNT = 's7kapanm';

/** File name the importer reads, mapped to the SmartSuite table id. */
export const SMARTSUITE_TABLES: Record<string, string> = {
  Boxes: '6ab80460bdfe42a53732d802',
  Trays: '6abec3b6dbcaac4160bb4474',
  Sleeves: '6abec34ef0214477ebca11b4',
  Edge_Guard: '6abecbcf6caea122d64d80e6',
  Packaging_Items_Corners: '6ab7fe0f29a900c3af33a4a7',
  Sleeve_Unique_Sizes: '6abeb9fbc4187735f1203fad',
  Products: '6ab79b7effa4acd30632d850',
};

/** A pull that returns far fewer rows than this is treated as broken and nothing is imported. */
export const MINIMUM_ROWS: Record<string, number> = { Boxes: 5, Trays: 3, Sleeves: 5, Sleeve_Unique_Sizes: 5, Products: 50 };

type Fetch = typeof fetch;

export interface SyncResult {
  ok: boolean;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  rows?: Record<string, number>;
  imported?: unknown;
  error?: string;
}

let running = false;
let last: SyncResult | null = null;

export function lastSmartSuiteSync(): SyncResult | null {
  return last;
}

export function smartSuiteConfigured(): boolean {
  return !!process.env.SMARTSUITE_API_KEY?.trim();
}

export async function fetchTable(id: string, fetchFn: Fetch = fetch): Promise<any[]> {
  const key = process.env.SMARTSUITE_API_KEY?.trim();
  if (!key) throw new Error('SMARTSUITE_API_KEY is not set');
  const headers = {
    Authorization: `Token ${key}`,
    'ACCOUNT-ID': process.env.SMARTSUITE_ACCOUNT_ID?.trim() || DEFAULT_ACCOUNT,
    'Content-Type': 'application/json',
  };
  const records: any[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetchFn(`${API}${id}/records/list/?offset=${offset}&limit=500`, { method: 'POST', headers, body: '{}' });
    if (!res.ok) throw new Error(`SmartSuite table ${id} answered ${res.status}`);
    const body: any = await res.json();
    const items: any[] = Array.isArray(body?.items) ? body.items : [];
    records.push(...items);
    offset += items.length;
    if (!items.length || offset >= Number(body?.total || 0)) break;
  }
  return records;
}

/** Writes each table as <dir>/<name>.json, the layout importPackagingSnapshot reads. Returns the row counts. */
export async function writeSnapshot(dir: string, fetchFn: Fetch = fetch): Promise<Record<string, number>> {
  mkdirSync(dir, { recursive: true });
  const rows: Record<string, number> = {};
  for (const [name, id] of Object.entries(SMARTSUITE_TABLES)) {
    const records = await fetchTable(id, fetchFn);
    const minimum = MINIMUM_ROWS[name] ?? 0;
    if (records.length < minimum) throw new Error(`SmartSuite ${name} returned ${records.length} rows, expected at least ${minimum}. Nothing imported.`);
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ records }));
    rows[name] = records.length;
  }
  return rows;
}

export async function syncPackagingFromSmartSuite(opts: { dryRun?: boolean; fetchFn?: Fetch } = {}): Promise<SyncResult> {
  const dryRun = opts.dryRun !== false;
  const startedAt = new Date().toISOString();
  if (running) return { ok: false, dryRun, startedAt, finishedAt: new Date().toISOString(), error: 'A sync is already running' };
  running = true;
  const dir = mkdtempSync(join(tmpdir(), 'smartsuite-packaging-'));
  try {
    const rows = await writeSnapshot(dir, opts.fetchFn);
    const imported = await importPackagingSnapshot({ dryRun, sourceDir: dir });
    last = { ok: true, dryRun, startedAt, finishedAt: new Date().toISOString(), rows, imported };
  } catch (err: any) {
    last = { ok: false, dryRun, startedAt, finishedAt: new Date().toISOString(), error: String(err?.message || err) };
  } finally {
    running = false;
    rmSync(dir, { recursive: true, force: true });
  }
  return last!;
}
