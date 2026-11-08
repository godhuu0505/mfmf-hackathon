import "server-only";

/** Exact server policy. Missing, empty or malformed configuration admits nobody. */
export function isLoginEmailAllowed(email: unknown): boolean {
  const configured = process.env.GOOGLE_LOGIN_ALLOWED_EMAILS;
  if (!configured || configured.length > 8192 || /[\u0000-\u001f\u007f]/u.test(configured)) return false;
  const allowed = configured.split(",").map(value => value.trim().toLowerCase());
  const valid = (value: string) => value.length <= 320 && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/u.test(value);
  if (allowed.length > 100 || allowed.some(value => !valid(value))) return false;
  return typeof email === "string" && valid(email) && allowed.includes(email.toLowerCase());
}

/** Provider verification must happen before this authorization check. */
export function isVerifiedLoginAllowed(identity: { email?: unknown; emailVerified?: unknown }): boolean {
  return identity.emailVerified === true && isLoginEmailAllowed(identity.email);
}
