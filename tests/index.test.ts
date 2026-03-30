import { describe, it, expect } from "bun:test";

interface Balance { token: string; usdValue: string; }

function checkDrift(
  portfolio: Balance[],
  targets: Record<string, number>
): Record<string, { current: number; target: number; drift: number }> {
  const total = portfolio.reduce((s, b) => s + parseFloat(b.usdValue), 0);
  const result: Record<string, { current: number; target: number; drift: number }> = {};
  for (const b of portfolio) {
    const current = total > 0 ? (parseFloat(b.usdValue) / total) * 100 : 0;
    const target = targets[b.token] ?? 0;
    result[b.token] = { current, target, drift: Math.abs(current - target) };
  }
  return result;
}

function needsRebalance(drift: Record<string, { drift: number }>, threshold: number): boolean {
  return Object.values(drift).some(d => d.drift > threshold);
}

const portfolio: Balance[] = [
  { token: "ETH", usdValue: "7000" },
  { token: "USDC", usdValue: "3000" },
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
    expect(drift.USDC.drift).toBe(10); // 30% vs 40% target
  });

  it("should handle empty portfolio", () => {
    const drift = checkDrift([], targets);
    expect(Object.keys(drift).length).toBe(0);
  });

  it("should handle perfect allocation", () => {
    const perfect: Balance[] = [
      { token: "ETH", usdValue: "6000" },
      { token: "USDC", usdValue: "4000" },
    ];
    const drift = checkDrift(perfect, targets);
    expect(drift.ETH.drift).toBe(0);
    expect(drift.USDC.drift).toBe(0);
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
