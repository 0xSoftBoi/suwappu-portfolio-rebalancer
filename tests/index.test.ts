import { describe, it, expect } from "bun:test";
import { checkDrift } from "../src/rebalancer.js";

function needsRebalance(drift: Record<string, { drift: number }>, threshold: number): boolean {
  return Object.values(drift).some(d => Math.abs(d.drift) > threshold);
}

const portfolio = [
  { token: "ETH", balance: "2", usdValue: "7000" },
  { token: "USDC", balance: "3000", usdValue: "3000" },
];
const targets = { ETH: 60, USDC: 40 };

describe("drift calculation", () => {
  it("should calculate current allocation", () => {
    const drift = checkDrift(portfolio, targets);
    expect(drift.ETH.current).toBe(70);
    expect(drift.USDC.current).toBe(30);
  });

  it("should calculate drift from target", () => {
    const drift = checkDrift(portfolio, targets);
    expect(drift.ETH.drift).toBe(10); // 70% vs 60% target
    expect(drift.USDC.drift).toBe(-10); // 30% vs 40% target
  });

  it("should handle empty portfolio", () => {
    const drift = checkDrift([], targets);
    expect(drift.ETH).toEqual({ current: 0, target: 60, drift: -60, usdValue: 0, configured: true });
    expect(drift.USDC).toEqual({ current: 0, target: 40, drift: -40, usdValue: 0, configured: true });
  });

  it("should handle perfect allocation", () => {
    const perfect = [
      { token: "ETH", balance: "2", usdValue: "6000" },
      { token: "USDC", balance: "4000", usdValue: "4000" },
    ];
    const drift = checkDrift(perfect, targets);
    expect(drift.ETH.drift).toBe(0);
    expect(drift.USDC.drift).toBe(0);
  });

  it("surfaces unexpected holdings without silently authorizing liquidation and aggregates duplicate symbols", () => {
    const drift = checkDrift(
      [
        { token: "eth", balance: "1", usdValue: "300" },
        { token: "ETH", balance: "1", usdValue: "300" },
        { token: "USDC", balance: "300", usdValue: "300" },
        { token: "ARB", balance: "100", usdValue: "100" },
      ],
      { ETH: 60, USDC: 40 },
    );

    expect(drift.ETH.usdValue).toBe(600);
    expect(drift.ARB.target).toBe(0);
    expect(drift.ARB.current).toBe(10);
    expect(drift.ARB.configured).toBe(false);
  });

  it("fails closed on malformed portfolio values", () => {
    expect(() => checkDrift(
      [{ token: "ETH", balance: "1", usdValue: "not-a-number" }],
      { ETH: 100 },
    )).toThrow();
  });
});

describe("rebalance trigger", () => {
  it("should trigger when drift exceeds threshold", () => {
    const drift = checkDrift(portfolio, targets);
    expect(needsRebalance(drift, 5)).toBe(true);
  });

  it("should not trigger when drift is within threshold", () => {
    const drift = checkDrift(portfolio, targets);
    expect(needsRebalance(drift, 15)).toBe(false);
  });
});
