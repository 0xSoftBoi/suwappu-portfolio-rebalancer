import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createDriftSnapshot,
  historyLimit,
  listDriftSnapshots,
  policyFingerprint,
  recordDriftSnapshot,
} from "../src/monitor.js";

let stateDir = "";

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "suwappu-rebalancer-monitor-test-"));
  process.env.SUWAPPU_REBALANCER_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.SUWAPPU_REBALANCER_STATE_DIR;
  delete process.env.SUWAPPU_REBALANCER_HISTORY_LIMIT;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("drift monitor state", () => {
  test("surfaces an unconfigured holding as a policy exception", () => {
    const snapshot = createDriftSnapshot({
      strategy: { allocations: { ETH: 50, USDC: 50 }, threshold: 5, chain: "base" },
      walletAddress: "0xabc",
      observedAt: "2026-08-07T00:00:00.000Z",
      drift: {
        ETH: { current: 49, target: 50, drift: -1, usdValue: 490, configured: true },
        USDC: { current: 49, target: 50, drift: -1, usdValue: 490, configured: true },
        ARB: { current: 2, target: 0, drift: 2, usdValue: 20, configured: false },
      },
    });

    expect(snapshot.thresholdBreached).toBe(false);
    expect(snapshot.policyException).toBe(true);
    expect(snapshot.needsAttention).toBe(true);
    expect(snapshot.unconfiguredHoldings).toEqual(["ARB"]);
  });

  test("policy fingerprint is stable across target order and symbol case", () => {
    const first = policyFingerprint({
      allocations: { ETH: 60, USDC: 40 }, threshold: 5, chain: "base",
    });
    const second = policyFingerprint({
      allocations: { usdc: 40, eth: 60 }, threshold: 5, chain: "BASE",
    });
    expect(second).toBe(first);
  });

  test("records bounded history and returns newest first", () => {
    process.env.SUWAPPU_REBALANCER_HISTORY_LIMIT = "2";
    const strategy = { allocations: { ETH: 100 }, threshold: 5, chain: "base" };
    for (const observedAt of [
      "2026-08-07T00:00:00.000Z",
      "2026-08-07T01:00:00.000Z",
      "2026-08-07T02:00:00.000Z",
    ]) {
      recordDriftSnapshot(createDriftSnapshot({
        strategy,
        walletAddress: "0xabc",
        observedAt,
        drift: {
          ETH: { current: 100, target: 100, drift: 0, usdValue: 1000, configured: true },
        },
      }));
    }

    const history = listDriftSnapshots(10);
    expect(history).toHaveLength(2);
    expect(history.map((item) => item.observedAt)).toEqual([
      "2026-08-07T02:00:00.000Z",
      "2026-08-07T01:00:00.000Z",
    ]);
  });

  test("fails closed instead of overwriting corrupt monitor history", () => {
    writeFileSync(join(stateDir, "drift-history.json"), "{not-json");
    expect(() => listDriftSnapshots()).toThrow("refusing to replace durable state");
  });

  test("rejects invalid history retention configuration", () => {
    process.env.SUWAPPU_REBALANCER_HISTORY_LIMIT = "0";
    expect(() => historyLimit()).toThrow("between 1 and 100000");
  });
});
