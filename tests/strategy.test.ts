import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadStrategy, validateStrategy } from "../src/strategy.js";

describe("strategy validation", () => {
  test("accepts a normalized 100% target on a real chain key", () => {
    expect(() => validateStrategy({
      allocations: { ETH: 50, USDC: 50 },
      threshold: 5,
      chain: "base",
    })).not.toThrow();
  });

  test("rejects negative allocations even when the total is 100", () => {
    expect(() => validateStrategy({
      allocations: { ETH: 110, USDC: -10 },
      threshold: 5,
      chain: "base",
    })).toThrow("between 0 and 100");
  });

  test("rejects case-insensitive duplicate targets", () => {
    expect(() => validateStrategy({
      allocations: { ETH: 50, eth: 50 },
      threshold: 5,
      chain: "base",
    })).toThrow("Duplicate target token");
  });

  test("does not merge defaults into an explicitly incomplete strategy", () => {
    const dir = mkdtempSync(join(tmpdir(), "suwappu-rebalancer-strategy-test-"));
    const path = join(dir, "strategy.json");
    try {
      writeFileSync(path, JSON.stringify({ allocations: { ETH: 100 }, chain: "base" }));
      expect(() => loadStrategy(path)).toThrow("defaults are not merged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
