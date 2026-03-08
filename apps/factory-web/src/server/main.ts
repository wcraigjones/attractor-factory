import express from "express";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authenticateBasicHeader,
  buildWwwAuthenticateHeader,
  isAuthEnabled,
  resolveAuthConfig,
  type AuthEnabledConfig
} from "@attractor/shared-auth";

const app = express();
app.set("trust proxy", true);

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const API_BASE_URL = process.env.API_BASE_URL ?? "/api";
const FACTORY_VERSION = (process.env.FACTORY_VERSION ?? "").trim() || "unknown";
const authConfig = resolveAuthConfig(process.env);

if (isAuthEnabled(authConfig)) {
  process.stdout.write(`factory-web basic auth enabled for user ${authConfig.username}\n`);
}

const currentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const clientDistCandidates = [
  resolve(currentDir, "../client"),
  resolve(currentDir, "../../../../../client"),
  resolve(process.cwd(), "apps/factory-web/dist/client"),
  resolve(process.cwd(), "dist/client")
];
const clientDist = clientDistCandidates.find((candidate) => existsSync(candidate));

function sendAuthChallenge(res: express.Response, config: AuthEnabledConfig): void {
  res.setHeader("WWW-Authenticate", buildWwwAuthenticateHeader(config));
  res.status(401).type("text/plain").send("authentication required");
}

app.use((req, res, next) => {
  if (!isAuthEnabled(authConfig)) {
    next();
    return;
  }
  if (req.method === "GET" && req.path === "/healthz") {
    next();
    return;
  }
  const principal = authenticateBasicHeader(req.headers.authorization, authConfig);
  if (!principal) {
    sendAuthChallenge(res, authConfig);
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

app.get("/app-config.js", (_req, res) => {
  res.type("application/javascript");
  res.send(
    `window.__FACTORY_APP_CONFIG__ = { apiBaseUrl: ${JSON.stringify(API_BASE_URL)}, factoryVersion: ${JSON.stringify(FACTORY_VERSION)} };`
  );
});

if (clientDist) {
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
