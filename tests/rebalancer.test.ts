import { describe, expect, test } from "bun:test";
import {
  calculateTrades,
  checkDrift,
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
});
