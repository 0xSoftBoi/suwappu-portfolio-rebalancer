import { readFileSync } from "fs";
import { join } from "path";

export interface Strategy {
  allocations: Record<string, number>;
  threshold: number;
  chain: string;
}

const DEFAULT_STRATEGY: Strategy = {
  allocations: { ETH: 50, USDC: 50 },
  threshold: 5,
  chain: "base",
};

export function loadStrategy(configPath?: string): Strategy {
  if (!configPath) return DEFAULT_STRATEGY;

  const resolved = configPath.startsWith("/")
    ? configPath
    : join(process.cwd(), configPath);

  const raw = readFileSync(resolved, "utf-8");
  const data = JSON.parse(raw) as Partial<Strategy> | null;
  if (!data || typeof data !== "object") {
    throw new Error("Explicit strategy file must contain a JSON object");
  }
  if (
    !data.allocations
    || typeof data.allocations !== "object"
    || Array.isArray(data.allocations)
    || typeof data.threshold !== "number"
    || typeof data.chain !== "string"
  ) {
    throw new Error(
      "Explicit strategy must define allocations (object), threshold (number), and chain (string); defaults are not merged into an explicit policy",
    );
  }

  return {
    allocations: data.allocations,
    threshold: data.threshold,
    chain: data.chain,
  };
}

export function validateStrategy(strategy: Strategy): void {
  const allocations = Object.entries(strategy.allocations);
  if (allocations.length === 0) {
    throw new Error("At least one target allocation is required");
  }

  const normalized = new Set<string>();
  for (const [token, target] of allocations) {
    const cleanToken = token.trim();
    if (!cleanToken || cleanToken !== token) {
      throw new Error(`Invalid target token symbol: ${JSON.stringify(token)}`);
    }
    const key = cleanToken.toUpperCase();
    if (normalized.has(key)) {
      throw new Error(`Duplicate target token after case normalization: ${token}`);
    }
    normalized.add(key);
    if (!Number.isFinite(target) || target < 0 || target > 100) {
      throw new Error(`Allocation for ${token} must be between 0 and 100`);
    }
  }

  const total = Object.values(strategy.allocations).reduce((a, b) => a + b, 0);

  if (Math.abs(total - 100) > 0.01) {
    throw new Error(
      `Allocations must sum to 100%, got ${total}%. Check your config.`
    );
  }

  if (!Number.isFinite(strategy.threshold) || strategy.threshold <= 0 || strategy.threshold > 50) {
    throw new Error(`Threshold must be between 0 and 50, got ${strategy.threshold}`);
  }

  if (!strategy.chain.trim()) {
    throw new Error("Strategy chain is required");
  }
}
