#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createClient } from "@suwappu/sdk";
import { loadApiKey, loadConfig } from "./config.js";
import {
  checkDrift,
  calculateTrades,
  executeRebalance,
  minRebalanceUsd,
  resumeRebalanceExecution,
} from "./rebalancer.js";
import { loadStrategy, validateStrategy } from "./strategy.js";
import { getPortfolio } from "./suwappu.js";
import {
  listExecutionJournal,
  reconcileExecutionJournal,
  withRebalanceWriterLock,
} from "./execution.js";
import {
  createDriftSnapshot,
  listDriftSnapshots,
  policyFingerprint,
  recordDriftSnapshot,
} from "./monitor.js";

const program = new Command();

function getClient(apiKey: string) {
  const configuredUrl = process.env.SUWAPPU_API_URL?.replace(/\/$/, "");
  return createClient({
    apiKey,
    ...(configuredUrl ? { baseUrl: configuredUrl } : {}),
  });
}

program
  .name("suwappu-rebalance")
  .description("Treasury drift monitor and preview-by-default portfolio rebalancer built on Suwappu")
  .version("2.0.0");

program
  .command("check")
  .description("Check portfolio drift from target allocations")
  .option("-c, --config <path>", "Config file path")
  .option("--json", "emit a stable machine-readable drift snapshot", false)
  .option("--record", "append the snapshot to durable local drift history", false)
  .option("--fail-on-drift", "set exit code 2 when drift/policy needs attention", false)
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const strategy = loadStrategy(config.strategyPath);
    validateStrategy(strategy);

    const spinner = opts.json ? undefined : ora("Fetching portfolio...").start();
    let portfolio: Awaited<ReturnType<typeof getPortfolio>>;
    try {
      portfolio = await getPortfolio(
        config.apiKey,
        config.walletAddress,
        strategy.chain,
      );
    } finally {
      spinner?.stop();
    }

    const drift = checkDrift(portfolio, strategy.allocations);
    const snapshot = createDriftSnapshot({
      drift,
      strategy,
      walletAddress: config.walletAddress,
    });
    if (opts.record) recordDriftSnapshot(snapshot);

    if (opts.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      if (opts.failOnDrift && snapshot.needsAttention) process.exitCode = 2;
      return;
    }

    console.log(chalk.bold("\nPortfolio Drift Report"));
    console.log(chalk.dim("─".repeat(50)));

    for (const [token, info] of Object.entries(drift)) {
      const driftPct = info.drift.toFixed(1);
      const color =
        Math.abs(info.drift) > strategy.threshold
          ? chalk.red
          : Math.abs(info.drift) > strategy.threshold / 2
            ? chalk.yellow
            : chalk.green;

      console.log(
        `  ${token.padEnd(8)} ${color(`${info.current.toFixed(1)}%`)} → ${
          info.configured ? `target ${info.target}%` : "UNCONFIGURED"
        }  (drift: ${color(`${driftPct}%`)})`,
      );
    }

    if (snapshot.policyException) {
      console.log(chalk.red(
        `\nPolicy attention required: unconfigured holdings ${snapshot.unconfiguredHoldings.join(", ")}`,
      ));
    } else if (snapshot.thresholdBreached) {
      console.log(chalk.yellow(`\nDrift threshold breached (${strategy.threshold}%)`));
    } else {
      console.log(chalk.green("\nPortfolio is within target range"));
    }
    console.log(chalk.dim(`Policy ${snapshot.policyFingerprint} | wallet ref ${snapshot.walletRef}`));
    if (opts.record) console.log(chalk.dim("Snapshot recorded in local drift history."));
    if (opts.failOnDrift && snapshot.needsAttention) process.exitCode = 2;
  });

program
  .command("rebalance")
  .description("Plan rebalancing swaps; add --execute for live managed-wallet execution")
  .option("-c, --config <path>", "Config file path")
  .option("--execute", "submit live managed-wallet swaps", false)
  .option("--dry-run", "deprecated alias for the now-default preview mode", false)
  .action(async (opts) => {
    if (opts.execute && opts.dryRun) {
      throw new Error("--execute and --dry-run cannot be used together");
    }

    const run = async () => {
      const config = loadConfig(opts.config);
      const strategy = loadStrategy(config.strategyPath);
      validateStrategy(strategy);
      const fingerprint = policyFingerprint(strategy);
      const client = opts.execute ? getClient(config.apiKey) : undefined;

      // An explicit live invocation first resumes/reconciles the prior economic
      // intent. The outer live-writer lock is held across this entire sequence,
      // including the fresh portfolio read and plan.
      if (client) {
        await resumeRebalanceExecution(client, {
          apiKey: config.apiKey,
          walletAddress: config.walletAddress,
          targets: strategy.allocations,
          policyFingerprint: fingerprint,
        });
      }

      const spinner = ora("Fetching portfolio...").start();
      let portfolio: Awaited<ReturnType<typeof getPortfolio>>;
      try {
        portfolio = await getPortfolio(
          config.apiKey,
          config.walletAddress,
          strategy.chain,
        );
      } finally {
        spinner.stop();
      }

      const drift = checkDrift(portfolio, strategy.allocations);
      const minimumUsd = minRebalanceUsd();
      const rawTrades = calculateTrades(drift, strategy.threshold, strategy.chain);
      const trades = calculateTrades(drift, strategy.threshold, strategy.chain, minimumUsd);
      const skippedForMinimum = rawTrades.length - trades.length;
      const thresholdBreached = Object.values(drift)
        .some((item) => item.configured && Math.abs(item.drift) > strategy.threshold);

      if (trades.length === 0) {
        if (thresholdBreached && skippedForMinimum > 0) {
          console.log(chalk.yellow(
            `Portfolio is outside the drift threshold, but no planned leg meets MIN_REBALANCE_USD ($${minimumUsd}). No action taken.`,
          ));
        } else {
          console.log(chalk.green("Portfolio is within target range. No trades needed."));
        }
        return;
      }

      console.log(
        chalk.bold(`\n${opts.execute ? "LIVE — " : "PREVIEW — "}Planned Trades:`),
      );
      for (const trade of trades) {
        console.log(
          `  ${trade.from} → ${trade.to}: $${trade.usdAmount.toFixed(2)} on ${trade.chain}`,
        );
      }
      if (skippedForMinimum > 0) {
        console.log(chalk.dim(
          `Skipped ${skippedForMinimum} planned leg(s) below MIN_REBALANCE_USD ($${minimumUsd}).`,
        ));
      }
      console.log(chalk.dim(`Policy fingerprint: ${fingerprint}`));

      if (!opts.execute) {
        console.log(chalk.dim("\nPreview only. Add --execute after reviewing the plan."));
        return;
      }

      const result = await executeRebalance(trades, client!, {
        apiKey: config.apiKey,
        walletAddress: config.walletAddress,
        targets: strategy.allocations,
        policyFingerprint: fingerprint,
      });
      console.log(chalk.green("\nOne rebalance action completed with reconciled final amounts."));
      console.log(
        result.hadAdditionalPlannedTrades
          ? chalk.yellow("Fetch a fresh portfolio and rerun --execute before taking another planned action.")
          : chalk.dim("Rerun rebalance to verify fresh post-trade drift before taking another action."),
      );
    };

    if (opts.execute) await withRebalanceWriterLock(run);
    else await run();
  });

program
  .command("history")
  .description("Inspect locally recorded drift-monitor snapshots")
  .option("--limit <n>", "number of recent snapshots", (value) => Number.parseInt(value, 10), 20)
  .option("--json", "emit machine-readable snapshot history", false)
  .action((opts) => {
    const snapshots = listDriftSnapshots(opts.limit);
    if (opts.json) {
      console.log(JSON.stringify(snapshots, null, 2));
      return;
    }
    for (const snapshot of snapshots) {
      const state = snapshot.needsAttention ? "ATTENTION" : "OK";
      const unconfigured = snapshot.unconfiguredHoldings.length
        ? ` unconfigured=${snapshot.unconfiguredHoldings.join(",")}`
        : "";
      console.log(
        `${snapshot.observedAt} ${state} $${snapshot.totalUsd.toFixed(2)} policy=${snapshot.policyFingerprint} wallet=${snapshot.walletRef}${unconfigured}`,
      );
    }
    if (snapshots.length === 0) console.log("No drift snapshots recorded yet. Use check --record.");
  });

program
  .command("executions")
  .description("Inspect durable managed-execution intents and reconciliation state")
  .option("-c, --config <path>", "Config file path used only to source API authority")
  .option("--limit <n>", "number of recent intents", (value) => Number.parseInt(value, 10), 20)
  .option("--reconcile", "poll known swap IDs before printing; never submits a trade", false)
  .action(async (opts) => {
    if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
      throw new Error("--limit must be a positive integer");
    }
    const entries = opts.reconcile
      ? await reconcileExecutionJournal(loadApiKey(opts.config))
      : listExecutionJournal(opts.limit);
    for (const entry of entries.slice(0, opts.limit)) {
      const swap = entry.swapId ? ` swap=${entry.swapId}` : "";
      const accounted = entry.accountedAt ? " accounted" : "";
      console.log(
        `${entry.createdAt} ${entry.actionKey} ${entry.phase}${swap}${accounted} intent=${entry.id}`,
      );
    }
    if (entries.length === 0) console.log("No managed execution intents recorded yet.");
  });

program
  .command("config")
  .description("Show current non-secret configuration")
  .option("-c, --config <path>", "Config file path")
  .action((opts) => {
    const config = loadConfig(opts.config);
    const strategy = loadStrategy(config.strategyPath);
    validateStrategy(strategy);

    console.log(chalk.bold("Configuration:"));
    console.log("  API Key:  configured (hidden)");
    console.log(
      `  Wallet:   ${config.walletAddress.slice(0, 6)}...${config.walletAddress.slice(-4)}`,
    );
    console.log(`  Strategy: ${config.strategyPath ?? "built-in default"}`);

    console.log(chalk.bold("\nTarget Allocations:"));
    for (const [token, pct] of Object.entries(strategy.allocations)) {
      console.log(`  ${token}: ${pct}%`);
    }
    console.log(`  Threshold: ${strategy.threshold}%`);
    console.log(`  Chain: ${strategy.chain}`);
  });

program.parseAsync().catch((error) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
