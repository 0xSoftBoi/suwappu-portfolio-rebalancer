#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "./config.js";
import { loadStrategy, validateStrategy } from "./strategy.js";
import { checkDrift, calculateTrades, executeRebalance } from "./rebalancer.js";
import { createClient } from "@suwappu/sdk";

const program = new Command();

program
  .name("suwappu-rebalance")
  .description("Automated portfolio rebalancer using Suwappu cross-chain DEX")
  .version("1.0.0");

program
  .command("check")
  .description("Check portfolio drift from target allocations")
  .option("-c, --config <path>", "Config file path")
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const strategy = loadStrategy(config.strategyPath);
    validateStrategy(strategy);

    const client = createClient({ apiKey: config.apiKey });
    const spinner = ora("Fetching portfolio...").start();

    const portfolio = await client.getPortfolio(strategy.chain);
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
        `  ${token.padEnd(8)} ${color(`${info.current.toFixed(1)}%`)} → target ${info.target}%  (drift: ${color(`${driftPct}%`)})`
      );
    }

    const needsRebalance = Object.values(drift).some(
      (d) => Math.abs(d.drift) > strategy.threshold
    );

    console.log(
      needsRebalance
        ? chalk.yellow(`\nRebalance needed (threshold: ${strategy.threshold}%)`)
        : chalk.green("\nPortfolio is within target range")
    );
  });

program
  .command("rebalance")
  .description("Execute rebalancing swaps")
  .option("-c, --config <path>", "Config file path")
  .option("--dry-run", "Show trades without executing", false)
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const strategy = loadStrategy(config.strategyPath);
    validateStrategy(strategy);

    const client = createClient({ apiKey: config.apiKey });
    const spinner = ora("Fetching portfolio...").start();

    const portfolio = await client.getPortfolio(strategy.chain);
    spinner.stop();

    const drift = checkDrift(portfolio, strategy.allocations);
    const trades = calculateTrades(drift, strategy.threshold, strategy.chain);

    if (trades.length === 0) {
      console.log(chalk.green("Portfolio is within target range. No trades needed."));
      return;
    }

    console.log(chalk.bold(`\n${opts.dryRun ? "DRY RUN — " : ""}Planned Trades:`));
    for (const trade of trades) {
      console.log(
        `  ${trade.from} → ${trade.to}: $${trade.usdAmount.toFixed(2)} on ${trade.chain}`
      );
    }

    if (opts.dryRun) {
      console.log(chalk.dim("\nDry run — no trades executed."));
      return;
    }

    await executeRebalance(trades, client);
    console.log(chalk.green("\nRebalance complete!"));
  });

program
  .command("config")
  .description("Show current configuration")
  .option("-c, --config <path>", "Config file path")
  .action((opts) => {
    const config = loadConfig(opts.config);
    console.log(chalk.bold("Configuration:"));
    console.log(`  API Key:  ${config.apiKey.slice(0, 20)}...`);
    console.log(`  Strategy: ${config.strategyPath}`);

    const strategy = loadStrategy(config.strategyPath);
    console.log(chalk.bold("\nTarget Allocations:"));
    for (const [token, pct] of Object.entries(strategy.allocations)) {
      console.log(`  ${token}: ${pct}%`);
    }
    console.log(`  Threshold: ${strategy.threshold}%`);
    console.log(`  Chain: ${strategy.chain}`);
  });

program.parse();
