import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";

export interface Config {
  apiKey: string;
  walletAddress: string;
  strategyPath?: string;
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".suwappu-rebalancer", "config.json");

function requireApiKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(
      "Missing/invalid API key. Set SUWAPPU_API_KEY (recommended) or configure apiKey without surrounding whitespace.",
    );
  }
  return value;
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath ? resolve(configPath) : DEFAULT_CONFIG_PATH;
  let fileConfig: Partial<Config> = {};

  if (configPath && !existsSync(filePath)) {
    throw new Error(`Explicit config file does not exist: ${filePath}`);
  }
  if (existsSync(filePath)) {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Config file must contain a JSON object: ${filePath}`);
    }
    const unknownFields = Object.keys(parsed)
      .filter((key) => !["apiKey", "walletAddress", "strategyPath"].includes(key));
    if (unknownFields.length > 0) {
      throw new Error(`Unsupported config field(s): ${unknownFields.join(", ")}`);
    }
    fileConfig = parsed as Partial<Config>;
  }

  const apiKey = requireApiKey(process.env.SUWAPPU_API_KEY ?? fileConfig.apiKey);
  const walletAddress =
    process.env.SUWAPPU_WALLET_ADDRESS ?? fileConfig.walletAddress;

  if (
    typeof walletAddress !== "string"
    || !walletAddress.trim()
    || walletAddress !== walletAddress.trim()
    || walletAddress.length > 256
  ) {
    throw new Error(
      "Missing/invalid wallet address. Set SUWAPPU_WALLET_ADDRESS (recommended) or configure walletAddress.",
    );
  }

  if (fileConfig.strategyPath !== undefined && typeof fileConfig.strategyPath !== "string") {
    throw new Error("strategyPath must be a string");
  }
  const strategyPath = fileConfig.strategyPath
    ? (isAbsolute(fileConfig.strategyPath)
      ? fileConfig.strategyPath
      : resolve(dirname(filePath), fileConfig.strategyPath))
    : undefined;

  return {
    apiKey,
    walletAddress,
    strategyPath,
  };
}

/**
 * Recovery/status polling needs API authority but does not need a wallet or a
 * valid portfolio policy. A valid environment key can therefore recover even
 * when the normal default config file needs repair.
 */
export function loadApiKey(configPath?: string): string {
  const filePath = configPath ? resolve(configPath) : DEFAULT_CONFIG_PATH;
  if (configPath && !existsSync(filePath)) {
    throw new Error(`Explicit config file does not exist: ${filePath}`);
  }
  if (process.env.SUWAPPU_API_KEY !== undefined) {
    return requireApiKey(process.env.SUWAPPU_API_KEY);
  }
  if (!existsSync(filePath)) return requireApiKey(undefined);

  const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${filePath}`);
  }
  return requireApiKey((parsed as { apiKey?: unknown }).apiKey);
}
