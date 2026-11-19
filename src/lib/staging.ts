/**
 * Staging is a separate warehouse. It may use its own database and the DX UAT
 * service only. Every other outbound call, including live APC, live DX, Royal Mail
 * and the shop, is refused before it leaves the process.
 */

const DX_UAT_HOST = 'uat-dm.dxdelivery.com'

export function isStaging(): boolean {
  return process.env.WAREHOUSE_ENV === 'staging'
}

export function databaseUrl(): string {
  return process.env.WAREHOUSE_DATABASE_URL || process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || ''
}

export function installStagingGuard(): void {
  if (!isStaging()) return

  const raw = databaseUrl()
  let host = ''
  try { host = new URL(raw).hostname.toLowerCase() } catch { host = '' }
  const banned = (process.env.STAGING_FORBIDDEN_DB_HOSTS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  if (!host || !banned.length || banned.includes(host) || host !== 'postgres.railway.internal') {
    console.error('Staging refused to start: database is missing or is the production database.')
    process.exit(1)
  }

  let dxHost = ''
  try { dxHost = new URL(process.env.DX_API_URL || '').hostname.toLowerCase() } catch { dxHost = '' }
  if (dxHost !== DX_UAT_HOST) {
    console.error('Staging refused to start: DX must use the UAT service.')
    process.exit(1)
  }

  for (const key of Object.keys(process.env)) {
    if (/^(MEDUSA_|APC_|ROYAL_MAIL_|UPS_|GENERO_)/.test(key)) delete process.env[key]
  }

  const original = globalThis.fetch
  globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let target = ''
    try { target = new URL(href).hostname.toLowerCase() } catch { target = '' }
    const allowed = target === 'localhost' || target === '127.0.0.1' || target === DX_UAT_HOST
    if (!allowed) throw new Error(`Staging blocked an outbound call to ${target || 'an unknown host'}`)
    return original(input, init)
  }

  console.log(`Staging isolation on. Database host ${host}. DX UAT only.`)
}
