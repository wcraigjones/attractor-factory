import { createHmac, timingSafeEqual } from "node:crypto";

const AUTH_ENV_KEYS = [
  "FACTORY_AUTH_GOOGLE_CLIENT_ID",
  "FACTORY_AUTH_GOOGLE_CLIENT_SECRET",
  "FACTORY_AUTH_ALLOWED_DOMAIN",
  "FACTORY_AUTH_SESSION_SECRET"
] as const;

const STATE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export const FACTORY_AUTH_SESSION_COOKIE_NAME = "factory_auth_session";

export interface AuthDisabledConfig {
  enabled: false;
}

export interface AuthEnabledConfig {
  enabled: true;
  googleClientId: string;
  googleClientSecret: string;
  allowedDomain: string;
  sessionSecret: string;
}

export type AuthConfig = AuthDisabledConfig | AuthEnabledConfig;

interface SignedStatePayload {
  exp: number;
  returnTo: string;
}

interface SignedSessionPayload {
  email: string;
  exp: number;
}

export interface SessionIdentity {
  email: string;
  domain: string;
  exp: number;
}

function unixTimeSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^@+/, "").replace(/\.+$/, "");
  if (!normalized || !DOMAIN_PATTERN.test(normalized)) {
    return "";
  }
  return normalized;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(payloadSegment: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadSegment).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function createSignedToken(payload: Record<string, unknown>, secret: string): string {
  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(payloadSegment, secret);
  return `${payloadSegment}.${signature}`;
}

function readSignedToken(token: string, secret: string): Record<string, unknown> | null {
  const [payloadSegment, signature] = token.split(".");
  if (!payloadSegment || !signature) {
    return null;
  }
  const expected = signPayload(payloadSegment, secret);
  if (!safeEqual(signature, expected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(payloadSegment));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function sanitizeReturnTo(value: string | null | undefined, fallback = "/"): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  if (!normalized.startsWith("/") || normalized.startsWith("//") || normalized.startsWith("/\\")) {
    return fallback;
  }
  return normalized;
}

export function emailDomainFromAddress(email: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  const at = normalizedEmail.lastIndexOf("@");
  if (at <= 0 || at === normalizedEmail.length - 1) {
    return "";
  }
  return normalizeDomain(normalizedEmail.slice(at + 1));
}

export function isEmailDomainAllowed(emailDomain: string, allowedDomain: string): boolean {
  const normalizedEmailDomain = normalizeDomain(emailDomain);
  const normalizedAllowedDomain = normalizeDomain(allowedDomain);
  if (!normalizedEmailDomain || !normalizedAllowedDomain) {
    return false;
  }
  return (
    normalizedEmailDomain === normalizedAllowedDomain ||
    normalizedEmailDomain.endsWith(`.${normalizedAllowedDomain}`)
  );
}

export function resolveAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const values = Object.fromEntries(
    AUTH_ENV_KEYS.map((key) => [key, (env[key] ?? "").trim()])
  ) as Record<(typeof AUTH_ENV_KEYS)[number], string>;
  const configured = AUTH_ENV_KEYS.filter((key) => values[key].length > 0);

  if (configured.length === 0) {
    return { enabled: false };
  }

  if (configured.length !== AUTH_ENV_KEYS.length) {
    const missing = AUTH_ENV_KEYS.filter((key) => values[key].length === 0);
    throw new Error(
      `Factory auth env vars must be all set or all unset. Missing: ${missing.join(", ")}`
    );
  }

  const allowedDomain = normalizeDomain(values.FACTORY_AUTH_ALLOWED_DOMAIN);
  if (!allowedDomain) {
    throw new Error("FACTORY_AUTH_ALLOWED_DOMAIN is invalid");
  }

  return {
    enabled: true,
    googleClientId: values.FACTORY_AUTH_GOOGLE_CLIENT_ID,
    googleClientSecret: values.FACTORY_AUTH_GOOGLE_CLIENT_SECRET,
    allowedDomain,
    sessionSecret: values.FACTORY_AUTH_SESSION_SECRET
  };
}

export function createStateToken(
  config: AuthEnabledConfig,
  returnTo: string,
  nowSeconds = unixTimeSeconds()
): string {
  return createSignedToken(
    {
      exp: nowSeconds + STATE_TTL_SECONDS,
      returnTo: sanitizeReturnTo(returnTo)
    } satisfies SignedStatePayload,
    config.sessionSecret
  );
}

export function readStateToken(
  config: AuthEnabledConfig,
  token: string,
  nowSeconds = unixTimeSeconds()
): { returnTo: string; exp: number } | null {
  const payload = readSignedToken(token, config.sessionSecret);
  if (!payload) {
    return null;
  }
  const exp = payload.exp;
  const returnTo = payload.returnTo;
  if (typeof exp !== "number" || !Number.isFinite(exp) || typeof returnTo !== "string") {
    return null;
  }
  if (exp <= nowSeconds) {
    return null;
  }
  return {
    exp,
    returnTo: sanitizeReturnTo(returnTo)
  };
}

export function createSessionToken(
  config: AuthEnabledConfig,
  email: string,
  nowSeconds = unixTimeSeconds()
): string {
  const normalizedEmail = email.trim().toLowerCase();
  const domain = emailDomainFromAddress(normalizedEmail);
  if (!domain || !isEmailDomainAllowed(domain, config.allowedDomain)) {
    throw new Error("email domain is not allowed");
  }
  return createSignedToken(
    {
      email: normalizedEmail,
      exp: nowSeconds + SESSION_TTL_SECONDS
    } satisfies SignedSessionPayload,
    config.sessionSecret
  );
}

export function readSessionToken(
  config: AuthEnabledConfig,
  token: string | undefined,
  nowSeconds = unixTimeSeconds()
): SessionIdentity | null {
  if (!token) {
    return null;
  }
  const payload = readSignedToken(token, config.sessionSecret);
  if (!payload) {
    return null;
  }
  const exp = payload.exp;
  const email = payload.email;
  if (typeof exp !== "number" || !Number.isFinite(exp) || typeof email !== "string") {
    return null;
  }
  if (exp <= nowSeconds) {
    return null;
  }
  const domain = emailDomainFromAddress(email);
  if (!domain || !isEmailDomainAllowed(domain, config.allowedDomain)) {
    return null;
  }
  return {
    email: email.trim().toLowerCase(),
    domain,
    exp
  };
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) {
    return cookies;
  }
  for (const pair of cookieHeader.split(";")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }
    const rawName = pair.slice(0, separatorIndex).trim();
    if (!rawName) {
      continue;
    }
    const rawValue = pair.slice(separatorIndex + 1).trim();
    try {
      cookies[rawName] = decodeURIComponent(rawValue);
    } catch {
      cookies[rawName] = rawValue;
    }
  }
  return cookies;
}

export function serializeSessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${FACTORY_AUTH_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function serializeClearSessionCookie(secure: boolean): string {
  const parts = [
    `${FACTORY_AUTH_SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
