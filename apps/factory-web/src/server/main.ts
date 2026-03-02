import express, { type Request } from "express";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FACTORY_AUTH_SESSION_COOKIE_NAME,
  createSessionToken,
  createStateToken,
  emailDomainFromAddress,
  isEmailDomainAllowed,
  parseCookieHeader,
  readSessionToken,
  readStateToken,
  resolveAuthConfig,
  sanitizeReturnTo,
  serializeClearSessionCookie,
  serializeSessionCookie
} from "./auth.js";

const app = express();
app.set("trust proxy", true);

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const API_BASE_URL = process.env.API_BASE_URL ?? "/api";
const FACTORY_VERSION = (process.env.FACTORY_VERSION ?? "").trim() || "unknown";
const authConfig = resolveAuthConfig(process.env);

if (authConfig.enabled) {
  process.stdout.write(`factory-web auth enabled for domain ${authConfig.allowedDomain}\n`);
}

const currentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const clientDist = resolve(currentDir, "../client");
const unauthenticatedPaths = new Set(["/healthz", "/auth/google/start", "/auth/google/callback", "/auth/logout"]);

function firstHeaderValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return "";
  }
  return raw.split(",")[0]?.trim() ?? "";
}

function requestOrigin(req: Request): string {
  const host = firstHeaderValue(req.headers["x-forwarded-host"]) || req.headers.host?.trim() || "";
  if (!host) {
    return "";
  }
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
  const socketEncrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
  const proto = forwardedProto || (socketEncrypted ? "https" : "http");
  return `${proto}://${host}`;
}

function isSecureRequest(req: Request): boolean {
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
  if (forwardedProto) {
    return forwardedProto === "https";
  }
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}

function queryValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return "";
}

app.use((req, res, next) => {
  if (!authConfig.enabled) {
    next();
    return;
  }
  if (unauthenticatedPaths.has(req.path)) {
    next();
    return;
  }
  const cookies = parseCookieHeader(req.headers.cookie);
  const session = readSessionToken(authConfig, cookies[FACTORY_AUTH_SESSION_COOKIE_NAME]);
  if (!session) {
    const returnTo = sanitizeReturnTo(req.originalUrl || req.url || "/");
    res.redirect(302, `/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`);
    return;
  }
  next();
});

app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    service: "factory-web",
    version: FACTORY_VERSION,
    apiBaseUrl: API_BASE_URL
  });
});

app.get("/auth/google/start", (req, res) => {
  const returnTo = sanitizeReturnTo(queryValue(req.query.returnTo), "/");
  if (!authConfig.enabled) {
    res.redirect(302, returnTo);
    return;
  }

  const origin = requestOrigin(req);
  if (!origin) {
    res.status(400).json({ error: "unable to resolve public origin" });
    return;
  }

  const callbackUrl = `${origin}/auth/google/callback`;
  const stateToken = createStateToken(authConfig, returnTo);
  const params = new URLSearchParams({
    client_id: authConfig.googleClientId,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: "openid email profile",
    state: stateToken,
    hd: authConfig.allowedDomain,
    prompt: "select_account"
  });

  res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/auth/google/callback", async (req, res) => {
  if (!authConfig.enabled) {
    res.redirect(302, "/");
    return;
  }

  const code = queryValue(req.query.code).trim();
  const stateToken = queryValue(req.query.state).trim();
  const state = readStateToken(authConfig, stateToken);
  if (!code || !state) {
    res.status(400).send("invalid auth callback");
    return;
  }

  const origin = requestOrigin(req);
  if (!origin) {
    res.status(400).send("unable to resolve public origin");
    return;
  }

  try {
    const callbackUrl = `${origin}/auth/google/callback`;
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: authConfig.googleClientId,
        client_secret: authConfig.googleClientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: callbackUrl
      })
    });

    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text();
      process.stderr.write(`google token exchange failed: ${detail}\n`);
      res.status(502).send("google token exchange failed");
      return;
    }

    const tokenPayload = (await tokenResponse.json()) as { access_token?: unknown };
    const accessToken = typeof tokenPayload.access_token === "string" ? tokenPayload.access_token : "";
    if (!accessToken) {
      res.status(502).send("google token exchange failed");
      return;
    }

    const userResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    if (!userResponse.ok) {
      const detail = await userResponse.text();
      process.stderr.write(`google userinfo fetch failed: ${detail}\n`);
      res.status(502).send("google userinfo fetch failed");
      return;
    }

    const userPayload = (await userResponse.json()) as {
      email?: unknown;
      email_verified?: unknown;
    };
    const email = typeof userPayload.email === "string" ? userPayload.email.trim().toLowerCase() : "";
    const emailVerified = userPayload.email_verified === true || userPayload.email_verified === "true";
    if (!email || !emailVerified) {
      res.status(403).send("google account email is not verified");
      return;
    }

    const domain = emailDomainFromAddress(email);
    if (!domain || !isEmailDomainAllowed(domain, authConfig.allowedDomain)) {
      res.status(403).send("email domain is not allowed");
      return;
    }

    const sessionToken = createSessionToken(authConfig, email);
    res.setHeader("Set-Cookie", serializeSessionCookie(sessionToken, isSecureRequest(req)));
    res.redirect(302, state.returnTo);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`google callback failed: ${message}\n`);
    res.status(502).send("google callback failed");
  }
});

app.get("/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", serializeClearSessionCookie(isSecureRequest(req)));
  if (!authConfig.enabled) {
    res.redirect(302, "/");
    return;
  }
  res.redirect(302, "/auth/google/start");
});

app.get("/app-config.js", (_req, res) => {
  res.type("application/javascript");
  res.send(
    `window.__FACTORY_APP_CONFIG__ = { apiBaseUrl: ${JSON.stringify(API_BASE_URL)}, factoryVersion: ${JSON.stringify(FACTORY_VERSION)} };`
  );
});

if (existsSync(clientDist)) {
  app.use(
    express.static(clientDist, {
      index: false,
      maxAge: "1h"
    })
  );

  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/api")) {
      return next();
    }
    res.sendFile(join(clientDist, "index.html"));
  });
} else {
  app.get(/.*/, (_req, res) => {
    res.status(503).json({ error: "factory-web client assets are missing; run build first" });
  });
}

app.listen(PORT, HOST, () => {
  process.stdout.write(`factory-web listening on http://${HOST}:${PORT}\n`);
});
