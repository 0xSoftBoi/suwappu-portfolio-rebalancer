import ora from "ora";
import chalk from "chalk";
import type { SuwappuClient } from "@suwappu/sdk";
import { executeManagedSwap, getPrices, simulateSwap } from "./suwappu.js";

export interface TokenBalance {
  token: string;
  balance: string;
  usdValue: string;
}

export interface DriftInfo {
  current: number;
  target: number;
  drift: number;
  usdValue: number;
}

export interface Trade {
  from: string;
  to: string;
  usdAmount: number;
  chain: string;
}

export function checkDrift(
  portfolio: TokenBalance[],
  targets: Record<string, number>,
): Record<string, DriftInfo> {
  const totalUsd = portfolio.reduce((sum, balance) => sum + parseFloat(balance.usdValue), 0);

  if (totalUsd === 0) {
    return Object.fromEntries(
      Object.entries(targets).map(([token, target]) => [
        token,
        { current: 0, target, drift: -target, usdValue: 0 },
      ]),
    );
  }

  const result: Record<string, DriftInfo> = {};
  for (const [token, target] of Object.entries(targets)) {
    const holding = portfolio.find(
      (balance) => balance.token.toUpperCase() === token.toUpperCase(),
    );
    const usdValue = holding ? parseFloat(holding.usdValue) : 0;
    const current = (usdValue / totalUsd) * 100;
    result[token] = { current, target, drift: current - target, usdValue };
  }
  return result;
}

export function calculateTrades(
  drift: Record<string, DriftInfo>,
  threshold: number,
  chain: string,
): Trade[] {
  const overweight: { token: string; excess: number }[] = [];
  const underweight: { token: string; deficit: number }[] = [];
  const totalUsd = Object.values(drift).reduce((sum, info) => sum + info.usdValue, 0);

  for (const [token, info] of Object.entries(drift)) {
    if (info.drift > threshold) {
      overweight.push({ token, excess: (info.drift / 100) * totalUsd });
    } else if (info.drift < -threshold) {
      underweight.push({ token, deficit: (-info.drift / 100) * totalUsd });
    }
  }

  const trades: Trade[] = [];
  let overweightIndex = 0;
  let underweightIndex = 0;
  let remainingExcess = overweight[0]?.excess ?? 0;
  let remainingDeficit = underweight[0]?.deficit ?? 0;

  while (overweightIndex < overweight.length && underweightIndex < underweight.length) {
    const usdAmount = Math.min(remainingExcess, remainingDeficit);
    trades.push({
      from: overweight[overweightIndex].token,
      to: underweight[underweightIndex].token,
      usdAmount,
      chain,
    });

    remainingExcess -= usdAmount;
    remainingDeficit -= usdAmount;

    if (remainingExcess <= 0.01) {
      overweightIndex++;
      remainingExcess = overweight[overweightIndex]?.excess ?? 0;
    }
    if (remainingDeficit <= 0.01) {
      underweightIndex++;
      remainingDeficit = underweight[underweightIndex]?.deficit ?? 0;
    }
  }

  return trades;
}

export function usdToTokenAmount(usdAmount: number, tokenPriceUsd: number): number {
  if (!Number.isFinite(usdAmount) || usdAmount <= 0) {
    throw new Error("USD trade amount must be positive");
  }
  if (!Number.isFinite(tokenPriceUsd) || tokenPriceUsd <= 0) {
    throw new Error("Source-token USD price must be positive");
  }
  return usdAmount / tokenPriceUsd;
}

export interface ExecuteRebalanceOptions {
  apiKey: string;
  walletAddress: string;
  targets?: Record<string, number>;
}

export async function executeRebalance(
  trades: Trade[],
  client: SuwappuClient,
  { apiKey, walletAddress, targets = {} }: ExecuteRebalanceOptions,
): Promise<void> {
  if (Object.keys(targets).length > 0) {
    const totalTarget = Object.values(targets).reduce((a, b) => a + b, 0);
    if (Math.abs(totalTarget - 100) > 0.01) {
      throw new Error(`Portfolio targets must sum to 100%, got ${totalTarget}%`);
    }
    if (Object.values(targets).some((target) => target < 0)) {
      throw new Error("Portfolio targets cannot be negative");
    }
  }

  const maxRebalanceUsd = parseFloat(process.env.MAX_REBALANCE_USD ?? "10000");
  const totalTrades = trades.reduce((sum, trade) => sum + trade.usdAmount, 0);
  if (totalTrades > maxRebalanceUsd) {
    throw new Error(
      `Total rebalance volume $${totalTrades.toFixed(2)} exceeds MAX_REBALANCE_USD ($${maxRebalanceUsd})`,
    );
  }

  const prices = await getPrices(
    apiKey,
    [...new Set(trades.map((trade) => trade.from.toUpperCase()))],
  );

  for (const trade of trades) {
    const spinner = ora(
      `Preparing $${trade.usdAmount.toFixed(2)} ${trade.from} → ${trade.to}...`,
    ).start();

    try {
      const priceUsd = prices[trade.from.toUpperCase()];
      if (!priceUsd) {
        throw new Error(`No USD price available for source token ${trade.from}`);
      }

      // calculateTrades() expresses intent in USD. getQuote() expects source
      // token units, so convert explicitly instead of treating "$425" as
      // "425 ETH".
      const fromAmount = usdToTokenAmount(trade.usdAmount, priceUsd);
      const quote = await client.getQuote(
        trade.from,
        trade.to,
        fromAmount,
        trade.chain,
      );

      const simulation = await simulateSwap(apiKey, quote.id, walletAddress);
      if (!simulation.success) {
        throw new Error(
          `Simulation failed: ${simulation.reason ?? "unknown reason"}`,
        );
      }

      const swap = await executeManagedSwap(apiKey, quote.id);
      const txLabel = swap.txHash ? ` | tx ${swap.txHash.slice(0, 16)}...` : "";
      spinner.succeed(
        chalk.green(
          `${trade.from} → ${trade.to}: $${trade.usdAmount.toFixed(2)} | swap ${swap.swapId} (${swap.status})${txLabel}`,
        ),
      );
    } catch (error) {
      spinner.fail(
        chalk.red(
          `${trade.from} → ${trade.to}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      throw error;
    }
  }
}
