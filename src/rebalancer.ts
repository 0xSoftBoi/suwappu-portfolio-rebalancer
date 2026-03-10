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
  client: SuwappuClient
): Promise<void> {
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

    const tx = await client.executeSwap(quote.id);
    spinner.succeed(
      chalk.green(
        `${trade.from} → ${trade.to}: $${trade.usdAmount.toFixed(2)} (tx: ${tx.txHash.slice(0, 16)}...)`
      )
    );
  }
}
