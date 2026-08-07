import { describe, expect, test } from "bun:test";
import {
  calculateTrades,
  checkDrift,
  maxRebalanceUsd,
  nextTradeForLiveExecution,
  usdToTokenAmount,
} from "../src/rebalancer.js";

describe("rebalance planning", () => {
  test("plans USD value needed to correct portfolio drift", () => {
    const drift = checkDrift(
      [
        { token: "ETH", balance: "0.2", usdValue: "600" },
        { token: "USDC", balance: "400", usdValue: "400" },
      ],
      { ETH: 50, USDC: 50 },
    );

    expect(drift.ETH?.drift).toBeCloseTo(10);
    expect(drift.USDC?.drift).toBeCloseTo(-10);

    expect(calculateTrades(drift, 5, "base")).toEqual([
      { from: "ETH", to: "USDC", usdAmount: 100, chain: "base" },
    ]);
  });

  test("converts planned USD value to source-token units before quoting", () => {
    expect(usdToTokenAmount(425, 3400)).toBeCloseTo(0.125);
  });

  test("rejects missing/invalid source-token prices", () => {
    expect(() => usdToTokenAmount(100, 0)).toThrow();
  });

  test("funds smaller underweights after one asset breaches the threshold", () => {
    const drift = checkDrift(
      [
        { token: "ETH", balance: "0.2", usdValue: "600" },
        { token: "USDC", balance: "200", usdValue: "200" },
        { token: "DAI", balance: "200", usdValue: "200" },
      ],
      { ETH: 50, USDC: 25, DAI: 25 },
    );

    expect(calculateTrades(drift, 5, "base")).toEqual([
      { from: "ETH", to: "USDC", usdAmount: 50, chain: "base" },
      { from: "ETH", to: "DAI", usdAmount: 50, chain: "base" },
    ]);
  });

  test("refuses to silently liquidate an unexpected holding", () => {
    const drift = checkDrift(
      [
        { token: "ETH", balance: "0.1", usdValue: "400" },
        { token: "USDC", balance: "400", usdValue: "400" },
        { token: "ARB", balance: "200", usdValue: "200" },
      ],
      { ETH: 50, USDC: 50 },
    );

    expect(() => calculateTrades(drift, 5, "base")).toThrow("no explicit target");
  });

  test("can liquidate a holding only when 0% is an explicit target", () => {
    const drift = checkDrift(
      [
        { token: "ETH", balance: "0.1", usdValue: "400" },
        { token: "USDC", balance: "400", usdValue: "400" },
        { token: "ARB", balance: "200", usdValue: "200" },
      ],
      { ETH: 50, USDC: 50, ARB: 0 },
    );

    expect(calculateTrades(drift, 5, "base")).toEqual([
      { from: "ARB", to: "ETH", usdAmount: 100, chain: "base" },
      { from: "ARB", to: "USDC", usdAmount: 100, chain: "base" },
    ]);
  });

  test("fails closed when the live aggregate cap is invalid", () => {
    const previous = process.env.MAX_REBALANCE_USD;
    process.env.MAX_REBALANCE_USD = "not-a-number";
    try {
      expect(() => maxRebalanceUsd()).toThrow("positive number");
    } finally {
      if (previous === undefined) delete process.env.MAX_REBALANCE_USD;
      else process.env.MAX_REBALANCE_USD = previous;
    }
  });

  test("executes one planned action before requiring a fresh portfolio", () => {
    const plan = [
      { from: "ETH", to: "USDC", usdAmount: 50, chain: "base" },
      { from: "ETH", to: "DAI", usdAmount: 50, chain: "base" },
    ];
    expect(nextTradeForLiveExecution(plan)).toEqual(plan[0]);
  });
});
