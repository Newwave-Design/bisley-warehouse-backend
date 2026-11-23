/**
 * Login secrets. This repo is public, so nothing here may fall back to a value written in the code
 * on a deployed server.
 */

/** Local development only: not production and not on Railway. */
export function devAuthAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID) return false;
  return true;
}

const DEV_JWT_SECRET = 'local-dev-only-secret';

/** JWT_SECRET. A deployed server without it refuses to sign or accept logins. */
export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret) return secret;
  if (devAuthAllowed()) return DEV_JWT_SECRET;
  throw new Error('JWT_SECRET is not set');
}

/** The internal demo token, only when DEMO_AUTH_TOKEN is set. There is no built-in default. */
export function demoToken(): string | null {
  const token = process.env.DEMO_AUTH_TOKEN?.trim();
  return token && token.length >= 32 ? token : null;
}
