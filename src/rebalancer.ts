import ora from "ora";
import chalk from "chalk";
import type { SuwappuClient } from "@suwappu/sdk";
import { getPrices } from "./suwappu.js";
import {
  abandonPreparedExecution,
  getUnaccountedExecution,
  markExecutionAccounted,
  runManagedExecution,
  type EconomicTerms,
  type ExecutionIntent,
} from "./execution.js";

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
  configured: boolean;
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
  const holdings = new Map<string, number>();
  for (const balance of portfolio) {
    const token = balance.token.trim().toUpperCase();
    const usdValue = Number(balance.usdValue);
    if (!token) throw new Error("Portfolio contains a balance with no token symbol");
    if (!Number.isFinite(usdValue) || usdValue < 0) {
      throw new Error(`Portfolio USD value for ${token} must be a non-negative number`);
    }
    holdings.set(token, (holdings.get(token) ?? 0) + usdValue);
  }

  const normalizedTargets = new Map<string, number>();
  for (const [token, target] of Object.entries(targets)) {
    normalizedTargets.set(token.toUpperCase(), target);
  }

  const totalUsd = [...holdings.values()].reduce((sum, value) => sum + value, 0);
  const tokens = new Set([...normalizedTargets.keys(), ...holdings.keys()]);

  if (totalUsd === 0) {
    return Object.fromEntries(
      [...normalizedTargets.entries()].map(([token, target]) => [
        token,
        { current: 0, target, drift: -target, usdValue: 0, configured: true },
      ]),
    );
  }

  const result: Record<string, DriftInfo> = {};
  for (const token of tokens) {
    const target = normalizedTargets.get(token) ?? 0;
    const usdValue = holdings.get(token) ?? 0;
    const current = (usdValue / totalUsd) * 100;
    result[token] = {
      current,
      target,
      drift: current - target,
      usdValue,
      configured: normalizedTargets.has(token),
    };
  }
  return result;
}

export function calculateTrades(
  drift: Record<string, DriftInfo>,
  threshold: number,
  chain: string,
): Trade[] {
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error("Rebalance threshold must be positive");
  }
  const unconfigured = Object.entries(drift)
    .filter(([, info]) => !info.configured && info.usdValue > 0.01)
    .map(([token]) => token);
  if (unconfigured.length > 0) {
    throw new Error(
      `Portfolio contains holdings with no explicit target: ${unconfigured.join(", ")}. `
      + "Add a target (including an explicit 0% if liquidation is intended) before planning trades.",
    );
  }
  if (!Object.values(drift).some((info) => Math.abs(info.drift) > threshold)) {
    return [];
  }

  const overweight: { token: string; excess: number }[] = [];
  const underweight: { token: string; deficit: number }[] = [];
  const totalUsd = Object.values(drift).reduce((sum, info) => sum + info.usdValue, 0);
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return [];

  for (const [token, info] of Object.entries(drift)) {
    // The threshold triggers a rebalance. Once triggered, trade the complete
    // positive/negative dollar gaps toward the configured targets so a +10%
    // overweight can fund two -5% underweights instead of yielding no plan.
    if (info.drift > 1e-9) {
      overweight.push({ token, excess: (info.drift / 100) * totalUsd });
    } else if (info.drift < -1e-9) {
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

export function maxRebalanceUsd(): number {
  const raw = process.env.MAX_REBALANCE_USD ?? "1000";
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("MAX_REBALANCE_USD must be a positive number");
  }
  return value;
}

/**
 * A live invocation performs at most one economic action. After a confirmed
 * fill the caller must fetch a fresh portfolio and re-plan rather than blindly
 * executing the rest of a stale multi-trade batch.
 */
export function nextTradeForLiveExecution(trades: Trade[]): Trade | undefined {
  return trades[0];
}

async function runExecutionIntent(
  client: SuwappuClient,
  options: ExecuteRebalanceOptions,
  actionKey: string,
  terms: EconomicTerms,
  context?: Record<string, string | number | boolean | null>,
): Promise<ExecutionIntent> {
  const receipt = await runManagedExecution({
    apiKey: options.apiKey,
    strategy: "rebalance",
    actionKey,
    terms,
    walletAddress: options.walletAddress,
    context,
    getQuote: async () => {
      const quote = await client.getQuote(
        terms.fromToken,
        terms.toToken,
        Number(terms.amount),
        terms.chain,
      );
      return { id: quote.id, toAmount: quote.toAmount };
    },
  });
  return receipt.intent;
}

function requireCompletedAmounts(intent: ExecutionIntent): void {
  if (intent.phase !== "completed") {
    const detail = intent.error ?? intent.swapStatus ?? intent.phase;
    throw new Error(
      `Rebalance intent ${intent.id} is ${intent.phase} (${detail}). `
      + "Do not submit a replacement trade; rerun --execute or use executions --reconcile.",
    );
  }
  if (!intent.actualFromAmount || !intent.actualToAmount) {
    throw new Error(
      `Rebalance intent ${intent.id} is terminal but final amounts are unavailable. `
      + "Keep it unaccounted and reconcile status before continuing.",
    );
  }
}

/**
 * Resume the one unresolved rebalance intent, if any, before reading a fresh
 * portfolio and creating a new plan. Explicit --execute is required by the CLI
 * before this function is called, so an outcome-unknown retry keeps the same
 * economic terms and idempotency key without silently granting new authority.
 */
export async function resumeRebalanceExecution(
  client: SuwappuClient,
  options: ExecuteRebalanceOptions,
): Promise<void> {
  while (true) {
    const existing = getUnaccountedExecution("rebalance");
    if (!existing) return;

    // `prepared` is provably pre-submit: the coordinator writes `submitting`
    // before the execute HTTP request. Do not revive a stale pre-submit plan
    // after a restart; abandon it and calculate from a fresh portfolio.
    if (existing.phase === "prepared") {
      abandonPreparedExecution(
        existing.id,
        "Abandoned stale pre-submit intent; a fresh portfolio will be planned instead",
      );
      continue;
    }

    const intent = await runExecutionIntent(
      client,
      options,
      existing.actionKey,
      existing.terms,
      existing.context,
    );
    requireCompletedAmounts(intent);
    // The journal itself is the durable audit record. Marking a reconciled
    // terminal result consumed lets the caller fetch a fresh portfolio before
    // it creates the next economic intent.
    markExecutionAccounted(intent.id);
  }
}

export async function executeRebalance(
  trades: Trade[],
  client: SuwappuClient,
  { apiKey, walletAddress, targets = {} }: ExecuteRebalanceOptions,
): Promise<{ executed: boolean; hadAdditionalPlannedTrades: boolean }> {
  if (Object.keys(targets).length > 0) {
    const totalTarget = Object.values(targets).reduce((a, b) => a + b, 0);
    if (Math.abs(totalTarget - 100) > 0.01) {
      throw new Error(`Portfolio targets must sum to 100%, got ${totalTarget}%`);
    }
    if (Object.values(targets).some((target) => target < 0)) {
      throw new Error("Portfolio targets cannot be negative");
    }
  }

  if (getUnaccountedExecution("rebalance")) {
    throw new Error(
      "An unresolved rebalance intent exists. Resume/reconcile it before creating a new trade.",
    );
  }

  const maxAllowedUsd = maxRebalanceUsd();
  if (trades.some((trade) => (
    !trade.from || !trade.to || trade.from.toUpperCase() === trade.to.toUpperCase()
    || !Number.isFinite(trade.usdAmount) || trade.usdAmount <= 0 || !trade.chain
  ))) {
    throw new Error("Rebalance plan contains invalid trade terms");
  }
  const trade = nextTradeForLiveExecution(trades);
  if (!trade) return { executed: false, hadAdditionalPlannedTrades: false };
  if (trade.usdAmount > maxAllowedUsd) {
    throw new Error(
      `Next rebalance action $${trade.usdAmount.toFixed(2)} exceeds MAX_REBALANCE_USD ($${maxAllowedUsd})`,
    );
  }

  const prices = await getPrices(
    apiKey,
    [trade.from.toUpperCase()],
  );

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
    const terms: EconomicTerms = {
      fromToken: trade.from,
      toToken: trade.to,
      amount: String(fromAmount),
      chain: trade.chain,
    };
    const actionKey = `${trade.from.toUpperCase()}-${trade.to.toUpperCase()}`;
    const intent = await runExecutionIntent(
      client,
      { apiKey, walletAddress, targets },
      actionKey,
      terms,
      { plannedUsd: trade.usdAmount, sourcePriceUsd: priceUsd },
    );
    requireCompletedAmounts(intent);
    const txLabel = intent.txHash ? ` | tx ${intent.txHash.slice(0, 16)}...` : "";
    spinner.succeed(
      chalk.green(
        `${trade.from} → ${trade.to}: confirmed ${intent.actualFromAmount} ${trade.from} → ${intent.actualToAmount} ${trade.to} | swap ${intent.swapId}${txLabel}`,
      ),
    );
    markExecutionAccounted(intent.id);
  } catch (error) {
    spinner.fail(
      chalk.red(
        `${trade.from} → ${trade.to}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    throw error;
  }

  return {
    executed: true,
    hadAdditionalPlannedTrades: trades.length > 1,
  };
}
