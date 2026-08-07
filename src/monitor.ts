import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import type { DriftInfo } from "./rebalancer.js";
import type { Strategy } from "./strategy.js";
import { readJsonFile, writeJsonAtomic } from "./storage.js";

export interface DriftSnapshot {
  schemaVersion: 1;
  observedAt: string;
  policyFingerprint: string;
  walletRef: string;
  chain: string;
  thresholdPct: number;
  totalUsd: number;
  thresholdBreached: boolean;
  policyException: boolean;
  needsAttention: boolean;
  unconfiguredHoldings: string[];
  drift: Record<string, DriftInfo>;
}

function stateDir(): string {
  return process.env.SUWAPPU_REBALANCER_STATE_DIR ?? join(homedir(), ".suwappu-rebalancer");
}

function historyFile(): string {
  return join(stateDir(), "drift-history.json");
}

function isDriftInfo(value: unknown): value is DriftInfo {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DriftInfo>;
  return Number.isFinite(item.current)
    && Number.isFinite(item.target)
    && Number.isFinite(item.drift)
    && Number.isFinite(item.usdValue)
    && typeof item.configured === "boolean";
}

function isDriftSnapshot(value: unknown): value is DriftSnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DriftSnapshot>;
  return item.schemaVersion === 1
    && typeof item.observedAt === "string"
    && typeof item.policyFingerprint === "string"
    && typeof item.walletRef === "string"
    && typeof item.chain === "string"
    && Number.isFinite(item.thresholdPct)
    && Number.isFinite(item.totalUsd)
    && typeof item.thresholdBreached === "boolean"
    && typeof item.policyException === "boolean"
    && typeof item.needsAttention === "boolean"
    && Array.isArray(item.unconfiguredHoldings)
    && item.unconfiguredHoldings.every((token) => typeof token === "string")
    && !!item.drift
    && typeof item.drift === "object"
    && Object.values(item.drift).every(isDriftInfo);
}

function isHistory(value: unknown): boolean {
  return Array.isArray(value) && value.every(isDriftSnapshot);
}

export function historyLimit(): number {
  const raw = process.env.SUWAPPU_REBALANCER_HISTORY_LIMIT ?? "5000";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error("SUWAPPU_REBALANCER_HISTORY_LIMIT must be an integer between 1 and 100000");
  }
  return value;
}

export function policyFingerprint(strategy: Strategy): string {
  const allocations = Object.fromEntries(
    Object.entries(strategy.allocations)
      .map(([token, target]) => [token.toUpperCase(), target] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const canonical = JSON.stringify({
    allocations,
    threshold: strategy.threshold,
    chain: strategy.chain.toLowerCase(),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function walletRef(walletAddress: string): string {
  return createHash("sha256").update(walletAddress.trim().toLowerCase()).digest("hex").slice(0, 12);
}

export function createDriftSnapshot(args: {
  drift: Record<string, DriftInfo>;
  strategy: Strategy;
  walletAddress: string;
  observedAt?: string;
}): DriftSnapshot {
  const unconfiguredHoldings = Object.entries(args.drift)
    .filter(([, info]) => !info.configured && info.usdValue > 0.01)
    .map(([token]) => token)
    .sort();
  const thresholdBreached = Object.values(args.drift)
    .some((info) => info.configured && Math.abs(info.drift) > args.strategy.threshold);
  const policyException = unconfiguredHoldings.length > 0;
  const totalUsd = Object.values(args.drift).reduce((sum, info) => sum + info.usdValue, 0);

  return {
    schemaVersion: 1,
    observedAt: args.observedAt ?? new Date().toISOString(),
    policyFingerprint: policyFingerprint(args.strategy),
    walletRef: walletRef(args.walletAddress),
    chain: args.strategy.chain,
    thresholdPct: args.strategy.threshold,
    totalUsd,
    thresholdBreached,
    policyException,
    needsAttention: thresholdBreached || policyException,
    unconfiguredHoldings,
    drift: args.drift,
  };
}

export function recordDriftSnapshot(snapshot: DriftSnapshot): void {
  const history = readJsonFile<DriftSnapshot[]>(historyFile(), () => [], isHistory);
  history.push(snapshot);
  const keep = historyLimit();
  writeJsonAtomic(historyFile(), history.slice(-keep));
}

export function listDriftSnapshots(limit = 50): DriftSnapshot[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("History limit must be a positive integer");
  }
  const history = readJsonFile<DriftSnapshot[]>(historyFile(), () => [], isHistory);
  return history.slice(-limit).reverse();
}
