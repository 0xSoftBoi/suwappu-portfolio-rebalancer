import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface Config {
  apiKey: string;
  strategyPath?: string;
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".suwappu-rebalancer", "config.json");

export function loadConfig(configPath?: string): Config {
  const apiKey = process.env.SUWAPPU_API_KEY;

  // Try loading from file
  const filePath = configPath ?? DEFAULT_CONFIG_PATH;
  let fileConfig: Partial<Config> = {};

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf-8");
    fileConfig = JSON.parse(raw) as Partial<Config>;
  }

  const resolvedKey = apiKey ?? fileConfig.apiKey;

  if (!resolvedKey) {
    throw new Error(
      "Missing API key. Set SUWAPPU_API_KEY env var or add apiKey to config file."
    );
  }

  return {
    apiKey: resolvedKey,
    strategyPath: fileConfig.strategyPath,
  };
}
