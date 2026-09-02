// Shared Medusa Admin API client with cached JWT auth

const MEDUSA_URL = process.env.MEDUSA_API_BASE_URL || 'https://bisley-shop.medusajs.app';
const MEDUSA_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || 'matt@ovara.co.uk';
const MEDUSA_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD;

let _token: string | null = null;
let _tokenExpiry = 0;

export async function getMedusaToken(): Promise<string> {
  if (_token && Date.now() < _tokenExpiry) return _token;
  if (!MEDUSA_PASSWORD) throw new Error('MEDUSA_ADMIN_PASSWORD env var is not set');
  const res = await fetch(`${MEDUSA_URL}/auth/user/emailpass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: MEDUSA_EMAIL, password: MEDUSA_PASSWORD }),
  });
  const data = await res.json() as any;
  if (!data.token) throw new Error(`Medusa auth failed: ${JSON.stringify(data)}`);
  _token = data.token;
  _tokenExpiry = Date.now() + 50 * 60 * 1000; // 50 min TTL
  return data.token;
}

export async function medusaGet(path: string): Promise<any> {
  const token = await getMedusaToken();
  const res = await fetch(`${MEDUSA_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

export { MEDUSA_URL };
