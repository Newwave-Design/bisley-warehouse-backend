import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MINIMUM_ROWS, SMARTSUITE_TABLES, fetchTable, writeSnapshot } from './smartsuite-sync.ts'
import { bomOptions, isSyncOwned } from './packaging-import.ts'

process.env.SMARTSUITE_API_KEY = 'test-key'

function fakeSmartSuite(rowsFor: (id: string) => number) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fn = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers })
    const id = url.split('/applications/')[1].split('/')[0]
    const offset = Number(new URL(url).searchParams.get('offset'))
    const total = rowsFor(id)
    const items = Array.from({ length: Math.max(0, Math.min(500, total - offset)) }, (_, i) => ({ id: `r${offset + i}`, title: `T${offset + i}` }))
    return { ok: true, status: 200, json: async () => ({ items, total }) }
  }) as unknown as typeof fetch
  return { fn, calls }
}

test('fetchTable pages through every row and sends the account header', async () => {
  const { fn, calls } = fakeSmartSuite(() => 1200)
  const rows = await fetchTable('abc', fn)
  assert.equal(rows.length, 1200)
  assert.equal(calls.length, 3)
  assert.equal(calls[0].headers['ACCOUNT-ID'], 's7kapanm')
  assert.equal(calls[0].headers.Authorization, 'Token test-key')
})

test('writeSnapshot writes one file per table', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-test-'))
  try {
    const { fn } = fakeSmartSuite((id) => (id === SMARTSUITE_TABLES.Products ? 120 : 60))
    const rows = await writeSnapshot(dir, fn)
    assert.equal(rows.Products, 120)
    assert.equal(JSON.parse(readFileSync(join(dir, 'Boxes.json'), 'utf8')).records.length, 60)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeSnapshot refuses a pull that is far too small', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-test-'))
  try {
    const { fn } = fakeSmartSuite(() => 1)
    await assert.rejects(() => writeSnapshot(dir, fn), new RegExp(`expected at least ${MINIMUM_ROWS.Boxes}`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('box is first choice and the sleeve set is the alternative', () => {
  assert.deepEqual(bomOptions(true, true).map((o) => `${o.rank}:${o.kind}`), ['1:box', '2:sleeve_tray'])
  assert.deepEqual(bomOptions(false, true).map((o) => `${o.rank}:${o.kind}`), ['1:sleeve_tray'])
  assert.deepEqual(bomOptions(true, false).map((o) => `${o.rank}:${o.kind}`), ['1:box'])
  assert.deepEqual(bomOptions(false, false), [])
})

test('hand-made BOMs are not owned by the sync', () => {
  assert.equal(isSyncOwned('smartsuite_snapshot'), true)
  assert.equal(isSyncOwned('smartsuite'), true)
  assert.equal(isSyncOwned('manual'), false)
  assert.equal(isSyncOwned(null), false)
})
