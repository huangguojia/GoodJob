import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  loadConfig,
  parseBaileysProxyUrl,
  parseBoolean,
  parsePort,
  parseWebOrigin
} from "../src/server/config";

const productionEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  DATABASE_CLIENT: "postgres",
  DATABASE_URL: "postgresql://app:password@db.example.test:5432/plugin",
  SESSION_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  WEB_ORIGIN: "https://crm.example.test",
  ...overrides
});

describe("server configuration", () => {
  it("uses opt-in Demo data and development-safe defaults", () => {
    expect(loadConfig({})).toMatchObject({
      nodeEnv: "development",
      host: "127.0.0.1",
      port: 3100,
      webOrigin: "http://127.0.0.1:5173",
      databaseClient: "pglite",
      seedDemo: false,
      enableDemoProvider: false,
      autoMigrate: true,
      allowPrivateAiEndpoints: false
    });
  });

  it("strictly parses booleans, ports, and the browser origin", () => {
    expect(parseBoolean("FEATURE", " TRUE ", false)).toBe(true);
    expect(parseBoolean("FEATURE", "false", true)).toBe(false);
    expect(() => parseBoolean("FEATURE", "yes", false)).toThrow(/true or false/u);
    expect(parsePort("65535")).toBe(65_535);
    for (const value of ["0", "65536", "12.5", "abc"]) {
      expect(() => parsePort(value)).toThrow(/between 1 and 65535/u);
    }
    expect(parseWebOrigin("https://crm.example.test/")).toBe("https://crm.example.test");
    expect(() => parseWebOrigin("https://crm.example.test/app")).toThrow(/scheme, host/u);
    expect(() => parseWebOrigin("https://user:password@crm.example.test")).toThrow(/scheme, host/u);
    expect(() => parseWebOrigin("*")).toThrow(/valid HTTP\(S\) origin/u);
  });

  it("accepts only optional HTTP(S) Baileys proxy URLs", () => {
    expect(parseBaileysProxyUrl(undefined)).toBeUndefined();
    expect(parseBaileysProxyUrl("  ")).toBeUndefined();
    expect(parseBaileysProxyUrl("http://127.0.0.1:7897")).toBe("http://127.0.0.1:7897/");
    expect(parseBaileysProxyUrl("https://proxy.example.test/connect")).toBe("https://proxy.example.test/connect");
    expect(() => parseBaileysProxyUrl("socks5://127.0.0.1:1080")).toThrow(/http or https/u);
    expect(() => parseBaileysProxyUrl("not a url")).toThrow(/valid HTTP\(S\) URL/u);
  });

  it("uses fail-closed production defaults", () => {
    expect(loadConfig(productionEnvironment())).toMatchObject({
      nodeEnv: "production",
      databaseClient: "postgres",
      seedDemo: false,
      enableDemoProvider: false,
      autoMigrate: false
    });
    expect(loadConfig(productionEnvironment({ META_GRAPH_BASE_URL: "https://graph.facebook.com/" })).metaGraphBaseUrl)
      .toBe("https://graph.facebook.com");
  });

  it("rejects ambiguous or unsafe production configuration", () => {
    expect(() => loadConfig({ NODE_ENV: "prod" })).toThrow(/NODE_ENV/u);
    expect(() => loadConfig({ DATABASE_CLIENT: "postres" })).toThrow(/DATABASE_CLIENT/u);
    expect(() => loadConfig(productionEnvironment({ DATABASE_CLIENT: "pglite" }))).toThrow(/postgres in production/u);
    expect(() => loadConfig(productionEnvironment({ DATABASE_URL: "" }))).toThrow(/DATABASE_URL/u);
    expect(() => loadConfig(productionEnvironment({ SESSION_MASTER_KEY: "not-base64" }))).toThrow(/32 bytes/u);
    expect(() => loadConfig(productionEnvironment({ SEED_DEMO: "true", ALLOW_DEMO_PROVIDER: "true" }))).toThrow(
      /SEED_DEMO/u
    );
    expect(() => loadConfig(productionEnvironment({ ALLOW_DEMO_PROVIDER: "true" }))).toThrow(/ALLOW_DEMO_PROVIDER/u);
    expect(() => loadConfig(productionEnvironment({ AUTO_MIGRATE: "true" }))).toThrow(/AUTO_MIGRATE/u);
    expect(() => loadConfig(productionEnvironment({ META_GRAPH_BASE_URL: "https://graph-proxy.example.test" }))).toThrow(
      /graph\.facebook\.com/u
    );
  });
});
