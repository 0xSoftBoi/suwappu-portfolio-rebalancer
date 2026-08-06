#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createClient } from "@suwappu/sdk";
import { loadConfig } from "./config.js";
import { checkDrift, calculateTrades, executeRebalance } from "./rebalancer.js";
import { loadStrategy, validateStrategy } from "./strategy.js";
import { getPortfolio } from "./suwappu.js";

const program = new Command();

program
  .name("suwappu-rebalance")
  .description("Preview-by-default portfolio rebalancer built on Suwappu")
  .version("1.0.0");

program
  .command("check")
  .description("Check portfolio drift from target allocations")
  .option("-c, --config <path>", "Config file path")
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const strategy = loadStrategy(config.strategyPath);
    validateStrategy(strategy);

    const spinner = ora("Fetching portfolio...").start();
    const portfolio = await getPortfolio(
      config.apiKey,
      config.walletAddress,
      strategy.chain,
    );
    spinner.stop();

    const drift = checkDrift(portfolio, strategy.allocations);
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
        `  ${token.padEnd(8)} ${color(`${info.current.toFixed(1)}%`)} → target ${info.target}%  (drift: ${color(`${driftPct}%`)})`,
      );
    }

    const needsRebalance = Object.values(drift).some(
      (item) => Math.abs(item.drift) > strategy.threshold,
    );
    console.log(
      needsRebalance
        ? chalk.yellow(`\nRebalance needed (threshold: ${strategy.threshold}%)`)
        : chalk.green("\nPortfolio is within target range"),
    );
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

    const config = loadConfig(opts.config);
    const strategy = loadStrategy(config.strategyPath);
    validateStrategy(strategy);

    const spinner = ora("Fetching portfolio...").start();
    const portfolio = await getPortfolio(
      config.apiKey,
      config.walletAddress,
      strategy.chain,
    );
    spinner.stop();

    const drift = checkDrift(portfolio, strategy.allocations);
    const trades = calculateTrades(drift, strategy.threshold, strategy.chain);

    if (trades.length === 0) {
      console.log(chalk.green("Portfolio is within target range. No trades needed."));
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

    if (!opts.execute) {
      console.log(chalk.dim("\nPreview only. Add --execute after reviewing the plan."));
      return;
    }

    const client = createClient({ apiKey: config.apiKey });
    await executeRebalance(trades, client, {
      apiKey: config.apiKey,
      walletAddress: config.walletAddress,
      targets: strategy.allocations,
    });
    console.log(chalk.green("\nRebalance submissions accepted."));
  });

program
  .command("config")
  .description("Show current non-secret configuration")
  .option("-c, --config <path>", "Config file path")
  .action((opts) => {
    const config = loadConfig(opts.config);
    const strategy = loadStrategy(config.strategyPath);

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
