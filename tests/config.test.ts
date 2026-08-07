import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadApiKey, loadConfig } from "../src/config.js";

let dir = "";
let previousApiKey: string | undefined;
let previousWallet: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suwappu-rebalancer-config-test-"));
  previousApiKey = process.env.SUWAPPU_API_KEY;
  previousWallet = process.env.SUWAPPU_WALLET_ADDRESS;
  process.env.SUWAPPU_API_KEY = "test-key";
  process.env.SUWAPPU_WALLET_ADDRESS = "0xabc";
});

afterEach(() => {
  if (previousApiKey === undefined) delete process.env.SUWAPPU_API_KEY;
  else process.env.SUWAPPU_API_KEY = previousApiKey;
  if (previousWallet === undefined) delete process.env.SUWAPPU_WALLET_ADDRESS;
  else process.env.SUWAPPU_WALLET_ADDRESS = previousWallet;
  rmSync(dir, { recursive: true, force: true });
});

describe("configuration safety", () => {
  test("fails closed when an explicit config path is missing", () => {
    expect(() => loadConfig(join(dir, "missing.json"))).toThrow("does not exist");
  });

  test("resolves strategyPath relative to the config file", () => {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ strategyPath: "strategy.json" }));
    const config = loadConfig(configPath);
    expect(config.strategyPath).toBe(join(dir, "strategy.json"));
  });

  test("rejects unknown config fields instead of silently using the default policy", () => {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ strategy_path: "strategy.json" }));
    expect(() => loadConfig(configPath)).toThrow("Unsupported config field");
  });

  test("rejects credentials with surrounding whitespace", () => {
    process.env.SUWAPPU_API_KEY = " test-key ";
    expect(() => loadConfig()).toThrow("Missing/invalid API key");
  });

  test("reconciliation can source a valid environment key without wallet policy config", () => {
    delete process.env.SUWAPPU_WALLET_ADDRESS;
    expect(loadApiKey()).toBe("test-key");
  });
});
