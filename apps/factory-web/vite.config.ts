import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import {
  authenticateBasicHeader,
  buildWwwAuthenticateHeader,
  isAuthEnabled,
  resolveAuthConfig
} from "../../packages/shared-auth/src/index";

function factoryBasicAuthPlugin(): Plugin {
  const authConfig = resolveAuthConfig(process.env);

  return {
    name: "factory-basic-auth",
    configureServer(server) {
      if (!isAuthEnabled(authConfig)) {
        return;
      }

      server.middlewares.use((req, res, next) => {
        const requestUrl = req.url ?? "/";
        const url = new URL(requestUrl, "http://localhost");
        if (req.method === "GET" && url.pathname === "/healthz") {
          next();
          return;
        }

        const principal = authenticateBasicHeader(req.headers.authorization, authConfig);
        if (principal) {
          next();
          return;
        }

        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", buildWwwAuthenticateHeader(authConfig));
        res.end("authentication required");
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), factoryBasicAuthPlugin()],
  resolve: {
    alias: {
      "@attractor/dot-engine": fileURLToPath(new URL("../../packages/dot-engine/src/index.ts", import.meta.url)),
      "@attractor/shared-auth": fileURLToPath(new URL("../../packages/shared-auth/src/index.ts", import.meta.url))
    }
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        ws: true
      },
      "/healthz": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true
      }
    }
  }
});
