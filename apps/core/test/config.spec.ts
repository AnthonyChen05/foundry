import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadConfig } from "../src/config.js";

describe("config", () => {
  it("has the documented defaults", () => {
    const c = loadConfig({});
    expect(c.port).toBe(8787);
    expect(c.host).toBe("127.0.0.1");
    expect(c.dataDir).toBe("./data");
    expect(c.dbPath).toBe("./data/foundry.db");
    expect(c.logLevel).toBe("info");
    expect(c.envTtlS).toBe(7200);
    expect(c.masterKey).toBeUndefined();
    expect(c.integration).toBe(false);
  });

  it("reads FOUNDRY_* overrides", () => {
    const c = loadConfig({
      FOUNDRY_PORT: "9000",
      FOUNDRY_HOST: "0.0.0.0",
      FOUNDRY_DATA_DIR: "/srv/foundry",
      FOUNDRY_MASTER_KEY: "abc",
      FOUNDRY_LOG_LEVEL: "debug",
      FOUNDRY_ENV_TTL: "60",
      FOUNDRY_INTEGRATION: "1",
    });
    expect(c.port).toBe(9000);
    expect(c.host).toBe("0.0.0.0");
    expect(c.dataDir).toBe("/srv/foundry");
    expect(c.dbPath).toBe("/srv/foundry/foundry.db");
    expect(c.masterKey).toBe("abc");
    expect(c.envTtlS).toBe(60);
    expect(c.integration).toBe(true);
  });

  it("dbPath overrides dataDir default", () => {
    const c = loadConfig({ FOUNDRY_DATA_DIR: "/x", FOUNDRY_DB_PATH: "/y/z.db" });
    expect(c.dbPath).toBe("/y/z.db");
  });

  it("rejects garbage numbers", () => {
    expect(() => loadConfig({ FOUNDRY_PORT: "not-a-port" })).toThrow(ConfigValidationError);
    expect(() => loadConfig({ FOUNDRY_PORT: "0" })).toThrow(ConfigValidationError);
    expect(() => loadConfig({ FOUNDRY_PORT: "8788.5" })).toThrow(ConfigValidationError);
  });

  it("blanks are treated as unset", () => {
    const c = loadConfig({ FOUNDRY_PORT: "", FOUNDRY_MASTER_KEY: " " });
    expect(c.port).toBe(8787);
    expect(c.masterKey).toBeUndefined();
  });
});