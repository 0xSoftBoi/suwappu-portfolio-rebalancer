import { readFileSync } from "fs";
import { join } from "path";

export interface Strategy {
  allocations: Record<string, number>;
  threshold: number;
  chain: string;
  rebalanceInterval?: string;
}

const DEFAULT_STRATEGY: Strategy = {
  allocations: { ETH: 50, SOL: 30, USDC: 20 },
  threshold: 5,
  chain: "arbitrum",
};

export function loadStrategy(configPath?: string): Strategy {
  if (!configPath) return DEFAULT_STRATEGY;

  const resolved = configPath.startsWith("/")
    ? configPath
    : join(process.cwd(), configPath);

  const raw = readFileSync(resolved, "utf-8");
  const data = JSON.parse(raw) as Partial<Strategy>;

  return {
    allocations: data.allocations ?? DEFAULT_STRATEGY.allocations,
    threshold: data.threshold ?? DEFAULT_STRATEGY.threshold,
    chain: data.chain ?? DEFAULT_STRATEGY.chain,
    rebalanceInterval: data.rebalanceInterval,
  };
}

export function validateStrategy(strategy: Strategy): void {
  const total = Object.values(strategy.allocations).reduce((a, b) => a + b, 0);

  if (Math.abs(total - 100) > 0.01) {
    throw new Error(
      `Allocations must sum to 100%, got ${total}%. Check your config.`
    );
  }

  if (strategy.threshold <= 0 || strategy.threshold > 50) {
    throw new Error(`Threshold must be between 0 and 50, got ${strategy.threshold}`);
  }
}
