import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface Config {
  apiKey: string;
  walletAddress: string;
  strategyPath?: string;
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".suwappu-rebalancer", "config.json");

export function loadConfig(configPath?: string): Config {
  const filePath = configPath ?? DEFAULT_CONFIG_PATH;
  let fileConfig: Partial<Config> = {};

  if (existsSync(filePath)) {
    fileConfig = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<Config>;
  }

  const apiKey = process.env.SUWAPPU_API_KEY ?? fileConfig.apiKey;
  const walletAddress =
    process.env.SUWAPPU_WALLET_ADDRESS ?? fileConfig.walletAddress;

  if (!apiKey) {
    throw new Error(
      "Missing API key. Set SUWAPPU_API_KEY (recommended) or configure apiKey.",
    );
  }
  if (!walletAddress) {
    throw new Error(
      "Missing wallet address. Set SUWAPPU_WALLET_ADDRESS (recommended) or configure walletAddress.",
    );
  }

  return {
    apiKey,
    walletAddress,
    strategyPath: fileConfig.strategyPath,
  };
}
