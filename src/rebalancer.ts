import ora from "ora";
import chalk from "chalk";
import type { SuwappuClient } from "@suwappu/sdk";

interface TokenBalance {
  token: string;
  balance: string;
  usdValue: string;
}

interface DriftInfo {
  current: number;
  target: number;
  drift: number;
  usdValue: number;
}

interface Trade {
  from: string;
  to: string;
  usdAmount: number;
  chain: string;
}

export function checkDrift(
  portfolio: TokenBalance[],
  targets: Record<string, number>
): Record<string, DriftInfo> {
  const totalUsd = portfolio.reduce((sum, b) => sum + parseFloat(b.usdValue), 0);

  if (totalUsd === 0) {
    return Object.fromEntries(
      Object.entries(targets).map(([token, target]) => [
        token,
        { current: 0, target, drift: -target, usdValue: 0 },
      ])
    );
  }

  const result: Record<string, DriftInfo> = {};

  for (const [token, target] of Object.entries(targets)) {
    const holding = portfolio.find(
      (b) => b.token.toUpperCase() === token.toUpperCase()
    );
    const usdValue = holding ? parseFloat(holding.usdValue) : 0;
    const current = (usdValue / totalUsd) * 100;

    result[token] = {
      current,
      target,
      drift: current - target,
      usdValue,
    };
  }

  return result;
}

export function calculateTrades(
  drift: Record<string, DriftInfo>,
  threshold: number,
  chain: string
): Trade[] {
  const overweight: { token: string; excess: number }[] = [];
  const underweight: { token: string; deficit: number }[] = [];

  const totalUsd = Object.values(drift).reduce((sum, d) => sum + d.usdValue, 0);

  for (const [token, info] of Object.entries(drift)) {
    if (info.drift > threshold) {
      overweight.push({ token, excess: (info.drift / 100) * totalUsd });
    } else if (info.drift < -threshold) {
      underweight.push({ token, deficit: (-info.drift / 100) * totalUsd });
    }
  }

  const trades: Trade[] = [];
  let oi = 0;
  let ui = 0;
  let remainingExcess = overweight[0]?.excess ?? 0;
  let remainingDeficit = underweight[0]?.deficit ?? 0;

  while (oi < overweight.length && ui < underweight.length) {
    const amount = Math.min(remainingExcess, remainingDeficit);

    trades.push({
      from: overweight[oi].token,
      to: underweight[ui].token,
      usdAmount: amount,
      chain,
    });

    remainingExcess -= amount;
    remainingDeficit -= amount;

    if (remainingExcess <= 0.01) {
      oi++;
      remainingExcess = overweight[oi]?.excess ?? 0;
    }
    if (remainingDeficit <= 0.01) {
      ui++;
      remainingDeficit = underweight[ui]?.deficit ?? 0;
    }
  }

  return trades;
}

export async function executeRebalance(
  trades: Trade[],
  client: SuwappuClient,
  targets: Record<string, number> = {}
): Promise<void> {
  if (Object.keys(targets).length > 0) {
    const totalTarget = Object.values(targets).reduce((a, b) => a + b, 0);
    if (Math.abs(totalTarget - 100) > 0.01) {
      throw new Error(`Portfolio targets must sum to 100%, got ${totalTarget}%`);
    }
    if (Object.values(targets).some((t) => t < 0)) {
      throw new Error('Portfolio targets cannot be negative');
    }
  }

  const MAX_REBALANCE_USD = parseFloat(process.env.MAX_REBALANCE_USD || '10000');
  const totalTrades = trades.reduce((sum, t) => sum + t.usdAmount, 0);
  if (totalTrades > MAX_REBALANCE_USD) {
    throw new Error(
      `Total rebalance volume $${totalTrades} exceeds MAX_REBALANCE_USD ($${MAX_REBALANCE_USD})`
    );
  }

  const SLIPPAGE_TOLERANCE = parseFloat(process.env.MAX_SLIPPAGE_PCT || '2') / 100;

  for (const trade of trades) {
    const spinner = ora(
      `Swapping $${trade.usdAmount.toFixed(2)} ${trade.from} → ${trade.to}...`
    ).start();

    const quote = await client.getQuote(
      trade.from,
      trade.to,
      trade.usdAmount,
      trade.chain
    );

    const amountOutMin = Number(quote.amountOut) * (1 - SLIPPAGE_TOLERANCE);
    if (Number(quote.amountOut) < amountOutMin) {
      spinner.fail(
        chalk.red(
          `${trade.from} → ${trade.to}: slippage exceeds ${process.env.MAX_SLIPPAGE_PCT || '2'}% tolerance, aborting trade`
        )
      );
      throw new Error(
        `Slippage on ${trade.from} → ${trade.to} exceeds tolerance (${SLIPPAGE_TOLERANCE * 100}%)`
      );
    }

    const tx = await client.executeSwap(quote.id);
    spinner.succeed(
      chalk.green(
        `${trade.from} → ${trade.to}: $${trade.usdAmount.toFixed(2)} (tx: ${tx.txHash.slice(0, 16)}...)`
      )
    );
  }
}
