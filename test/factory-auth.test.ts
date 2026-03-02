import { describe, expect, it } from "vitest";
import * as webAuth from "../apps/factory-web/src/server/auth";
import * as apiAuth from "../apps/factory-api/src/auth";

type AuthModule = typeof webAuth;

const modules: Array<{ name: string; auth: AuthModule }> = [
  { name: "web", auth: webAuth },
  { name: "api", auth: apiAuth }
];

const ENABLED_ENV: NodeJS.ProcessEnv = {
  FACTORY_AUTH_GOOGLE_CLIENT_ID: "google-client-id",
  FACTORY_AUTH_GOOGLE_CLIENT_SECRET: "google-client-secret",
  FACTORY_AUTH_ALLOWED_DOMAIN: "PelicanDynamics.com",
  FACTORY_AUTH_SESSION_SECRET: "very-secret-value"
};

function enabledConfig(auth: AuthModule): Extract<ReturnType<AuthModule["resolveAuthConfig"]>, { enabled: true }> {
  const config = auth.resolveAuthConfig(ENABLED_ENV);
  if (!config.enabled) {
    throw new Error("expected enabled config");
  }
  return config;
}

for (const { name, auth } of modules) {
  describe(`${name} factory auth`, () => {
    it("disables auth when all auth env vars are unset", () => {
      expect(auth.resolveAuthConfig({})).toEqual({ enabled: false });
    });

    it("throws when auth env vars are partially configured", () => {
      expect(() =>
        auth.resolveAuthConfig({
          FACTORY_AUTH_GOOGLE_CLIENT_ID: "id",
          FACTORY_AUTH_ALLOWED_DOMAIN: "pelicandynamics.com"
        })
      ).toThrow(/Missing:/);
    });

    it("enables auth and normalizes configured domain", () => {
      const config = enabledConfig(auth);
      expect(config.allowedDomain).toBe("pelicandynamics.com");
    });

    it("roundtrips signed state token and rejects tampering", () => {
      const config = enabledConfig(auth);
      const now = 1_700_000_000;
      const stateToken = auth.createStateToken(config, "/projects/abc?tab=1", now);
      const state = auth.readStateToken(config, stateToken, now + 1);
      expect(state?.returnTo).toBe("/projects/abc?tab=1");

      const [payload, signature] = stateToken.split(".");
      const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}`;
      expect(auth.readStateToken(config, `${payload}.${tamperedSignature}`, now + 1)).toBeNull();
    });

    it("rejects expired state token", () => {
      const config = enabledConfig(auth);
      const now = 1_700_000_000;
      const stateToken = auth.createStateToken(config, "/", now);
      expect(auth.readStateToken(config, stateToken, now + 601)).toBeNull();
    });

    it("roundtrips session token for allowed exact and subdomains", () => {
      const config = enabledConfig(auth);
      const now = 1_700_000_000;

      const exact = auth.createSessionToken(config, "dev@pelicandynamics.com", now);
      const exactSession = auth.readSessionToken(config, exact, now + 1);
      expect(exactSession?.email).toBe("dev@pelicandynamics.com");

      const subdomain = auth.createSessionToken(config, "dev@eng.pelicandynamics.com", now);
      const subdomainSession = auth.readSessionToken(config, subdomain, now + 1);
      expect(subdomainSession?.domain).toBe("eng.pelicandynamics.com");
    });

    it("rejects disallowed domain", () => {
      const config = enabledConfig(auth);
      expect(() => auth.createSessionToken(config, "dev@other.com")).toThrow(/not allowed/);
      expect(auth.isEmailDomainAllowed("other.com", config.allowedDomain)).toBe(false);
    });

    it("rejects expired session token", () => {
      const config = enabledConfig(auth);
      const now = 1_700_000_000;
      const token = auth.createSessionToken(config, "dev@pelicandynamics.com", now);
      expect(auth.readSessionToken(config, token, now + 43_201)).toBeNull();
    });

    it("sanitizes returnTo and parses cookies", () => {
      expect(auth.sanitizeReturnTo("https://evil.example")).toBe("/");
      expect(auth.sanitizeReturnTo("//evil.example/path")).toBe("/");
      expect(auth.sanitizeReturnTo("/projects/1?tab=run")).toBe("/projects/1?tab=run");

      const parsed = auth.parseCookieHeader("a=1; factory_auth_session=abc%2E123");
      expect(parsed.a).toBe("1");
      expect(parsed.factory_auth_session).toBe("abc.123");
    });
  });
}
