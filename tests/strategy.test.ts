import { describe, expect, test } from "bun:test";
import { validateStrategy } from "../src/strategy.js";

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
});
