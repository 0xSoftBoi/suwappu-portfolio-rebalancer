/**
 * Durable managed-execution coordinator for rebalance intents.
 *
 * The idempotency key is written before submission. A known swap is reconciled
 * instead of resubmitted, and an outcome-unknown retry keeps the same economic
 * intent even when it needs a fresh quote.
 */
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readJsonFile, writeJsonAtomic } from "./storage.js";
import {
  executeManagedSwap,
  getManagedSwapStatus,
  isFailedSwapStatus,
  isSuccessfulSwapStatus,
  ManagedSwapRequestError,
  simulateManagedSwap,
} from "./suwappu.js";

export type ExecutionPhase =
  | "prepared"
  | "submitting"
  | "submitted"
  | "completed"
  | "failed"
  | "outcome_unknown";

export interface EconomicTerms {
  fromToken: string;
  toToken: string;
  amount: string;
  chain: string;
}

export interface ExecutionIntent {
  id: string;
  strategy: string;
  actionKey: string;
  phase: ExecutionPhase;
  terms: EconomicTerms;
  context?: Record<string, string | number | boolean | null>;
  quoteId?: string;
  quotedToAmount?: string;
  swapId?: string;
  swapStatus?: string;
  txHash?: string;
  actualFromAmount?: string;
  actualToAmount?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  accountedAt?: string;
}

export interface QuoteForExecution {
  id: string;
  toAmount: string;
}

function stateDir(): string {
  return process.env.SUWAPPU_REBALANCER_STATE_DIR ?? join(homedir(), ".suwappu-rebalancer");
}

function journalFile(): string {
  return join(stateDir(), "execution-journal.json");
}

function writerLockFile(): string {
  return join(stateDir(), "rebalance-live.lock");
}

export class RebalanceWriterLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RebalanceWriterLockError";
  }
}

/**
 * Hold one lock across the complete live cycle: resume -> portfolio read ->
 * plan -> submit/reconcile -> accounting. A per-request lock is insufficient
 * because a second process could otherwise build a stale plan while the first
 * process is completing an earlier action.
 */
export async function withRebalanceWriterLock<T>(work: () => Promise<T>): Promise<T> {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  chmodSync(stateDir(), 0o700);
  const path = writerLockFile();
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new RebalanceWriterLockError(
        `Live rebalance lock ${path} already exists; another writer may be active. Stop live writers and reconcile before treating it as stale`,
      );
    }
    throw error;
  }

  try {
    writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      "utf-8",
    );
    fsyncSync(fd);
    return await work();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}

const EXECUTION_PHASES = new Set<ExecutionPhase>([
  "prepared",
  "submitting",
  "submitted",
  "completed",
  "failed",
  "outcome_unknown",
]);

function isExecutionIntent(value: unknown): value is ExecutionIntent {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ExecutionIntent>;
  const terms = entry.terms as Partial<EconomicTerms> | undefined;
  return typeof entry.id === "string"
    && typeof entry.strategy === "string"
    && typeof entry.actionKey === "string"
    && typeof entry.phase === "string"
    && EXECUTION_PHASES.has(entry.phase as ExecutionPhase)
    && !!terms
    && typeof terms.fromToken === "string"
    && typeof terms.toToken === "string"
    && typeof terms.amount === "string"
    && typeof terms.chain === "string"
    && typeof entry.createdAt === "string"
    && typeof entry.updatedAt === "string"
    && (entry.accountedAt === undefined || typeof entry.accountedAt === "string")
    && (entry.swapId === undefined || typeof entry.swapId === "string")
    && (entry.quoteId === undefined || typeof entry.quoteId === "string")
    && (entry.actualFromAmount === undefined || typeof entry.actualFromAmount === "string")
    && (entry.actualToAmount === undefined || typeof entry.actualToAmount === "string");
}

function loadJournal(): ExecutionIntent[] {
  return readJsonFile<ExecutionIntent[]>(
    journalFile(),
    () => [],
    (value) => Array.isArray(value) && value.every(isExecutionIntent),
  );
}

function saveJournal(entries: ExecutionIntent[]): void {
  writeJsonAtomic(journalFile(), entries);
}

function saveEntry(entry: ExecutionIntent): void {
  const entries = loadJournal();
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  entry.updatedAt = new Date().toISOString();
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  // Never prune unresolved intents: losing an old idempotency key can turn a
  // recovery attempt into a new economic action.
  saveJournal(entries);
}

function sameTerms(a: EconomicTerms, b: EconomicTerms): boolean {
  return a.fromToken.toUpperCase() === b.fromToken.toUpperCase()
    && a.toToken.toUpperCase() === b.toToken.toUpperCase()
    && a.chain.toLowerCase() === b.chain.toLowerCase()
    && a.amount === b.amount;
}

function makeIntentId(): string {
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `rb.rebalance.${Date.now().toString(36)}.${random}`.slice(0, 64);
}

function currentIntent(strategy: string, actionKey: string): ExecutionIntent | undefined {
  return loadJournal().slice().reverse().find((entry) => (
    entry.strategy === strategy
    && entry.actionKey === actionKey
    && !entry.accountedAt
    && entry.phase !== "failed"
  ));
}

export function getUnaccountedExecution(strategy: string): ExecutionIntent | undefined {
  return loadJournal().slice().reverse().find((entry) => (
    entry.strategy === strategy && !entry.accountedAt && entry.phase !== "failed"
  ));
}

export function listExecutionJournal(limit = 25): ExecutionIntent[] {
  return loadJournal().slice(-Math.max(1, limit)).reverse();
}

export function markExecutionAccounted(intentId: string): void {
  const entries = loadJournal();
  const entry = entries.find((candidate) => candidate.id === intentId);
  if (!entry) return;
  entry.accountedAt = new Date().toISOString();
  entry.updatedAt = entry.accountedAt;
  saveJournal(entries);
}

export function abandonPreparedExecution(intentId: string, reason: string): void {
  const entries = loadJournal();
  const entry = entries.find((candidate) => candidate.id === intentId);
  if (!entry) return;
  if (entry.phase !== "prepared") {
    throw new Error(`Cannot abandon ${entry.phase} execution intent ${intentId}`);
  }
  entry.phase = "failed";
  entry.error = reason;
  entry.updatedAt = new Date().toISOString();
  saveJournal(entries);
}

function applyStatus(
  entry: ExecutionIntent,
  status: Awaited<ReturnType<typeof getManagedSwapStatus>>,
): void {
  entry.swapId = status.swapId;
  entry.swapStatus = status.status;
  entry.txHash = status.txHash ?? entry.txHash;
  entry.actualFromAmount = status.fromAmount ?? entry.actualFromAmount;
  entry.actualToAmount = status.toAmount ?? entry.actualToAmount;
  entry.error = status.errorMessage ?? undefined;
  if (isSuccessfulSwapStatus(status.status)) entry.phase = "completed";
  else if (isFailedSwapStatus(status.status)) entry.phase = "failed";
  else entry.phase = "submitted";
}

async function reconcileKnownSwap(apiKey: string, entry: ExecutionIntent): Promise<ExecutionIntent> {
  if (!entry.swapId) return entry;
  try {
    const status = await getManagedSwapStatus(apiKey, entry.swapId);
    applyStatus(entry, status);
    saveEntry(entry);
  } catch (error) {
    entry.error = `Reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`;
    saveEntry(entry);
  }
  return entry;
}

/** Poll known swap IDs only. This function never creates a quote or submits. */
export async function reconcileExecutionJournal(apiKey: string): Promise<ExecutionIntent[]> {
  return withRebalanceWriterLock(async () => {
    const entries = loadJournal();
    for (const entry of entries) {
      if (entry.accountedAt || !entry.swapId || entry.phase === "failed") continue;
      await reconcileKnownSwap(apiKey, entry);
    }
    return listExecutionJournal(entries.length || 1);
  });
}

export async function runManagedExecution(args: {
  apiKey: string;
  strategy: string;
  actionKey: string;
  terms: EconomicTerms;
  getQuote: () => Promise<QuoteForExecution>;
  walletAddress: string;
  context?: Record<string, string | number | boolean | null>;
}): Promise<{ intent: ExecutionIntent }> {
  let intent = currentIntent(args.strategy, args.actionKey);

  if (intent && !sameTerms(intent.terms, args.terms)) {
    throw new Error(
      `Unreconciled ${args.strategy}/${args.actionKey} intent ${intent.id} has different economic terms`,
    );
  }

  if (intent?.phase === "completed") {
    if (intent.swapId && (!intent.actualFromAmount || !intent.actualToAmount)) {
      intent = await reconcileKnownSwap(args.apiKey, intent);
    }
    return { intent };
  }

  if (intent?.swapId) {
    intent = await reconcileKnownSwap(args.apiKey, intent);
    return { intent };
  }

  const isNew = !intent;
  if (!intent) {
    const now = new Date().toISOString();
    intent = {
      id: makeIntentId(),
      strategy: args.strategy,
      actionKey: args.actionKey,
      phase: "prepared",
      terms: args.terms,
      context: args.context,
      createdAt: now,
      updatedAt: now,
    };
    saveEntry(intent);
  }

  let quote: QuoteForExecution;
  try {
    quote = await args.getQuote();
  } catch (error) {
    if (isNew) {
      intent.phase = "failed";
      intent.error = `Quote failed before submission: ${error instanceof Error ? error.message : String(error)}`;
      saveEntry(intent);
    }
    throw error;
  }

  intent.quoteId = quote.id;
  intent.quotedToAmount = quote.toAmount;
  saveEntry(intent);

  const simulation = await simulateManagedSwap(args.apiKey, quote.id, args.walletAddress);
  if (!simulation.wouldExecute) {
    const warnings = simulation.warnings.length ? `: ${simulation.warnings.join("; ")}` : "";
    if (isNew && intent.phase === "prepared") {
      intent.phase = "failed";
      intent.error = `Simulation blocked execution${warnings}`;
    } else {
      intent.phase = "outcome_unknown";
      intent.error = `Retry simulation blocked while an earlier submission may have executed${warnings}`;
    }
    saveEntry(intent);
    return { intent };
  }

  // This persisted state means a crash from here onward is ambiguous. Any
  // retry uses this same server-compatible idempotency key.
  intent.phase = "submitting";
  intent.error = undefined;
  saveEntry(intent);

  try {
    const swap = await executeManagedSwap(args.apiKey, quote.id, {
      idempotencyKey: intent.id,
    });
    intent.swapId = swap.swapId;
    intent.swapStatus = swap.status;
    intent.txHash = swap.txHash;
    intent.phase = isSuccessfulSwapStatus(swap.status)
      ? "completed"
      : isFailedSwapStatus(swap.status)
        ? "failed"
        : "submitted";
    saveEntry(intent);

    if (intent.swapId && intent.phase === "completed") {
      intent = await reconcileKnownSwap(args.apiKey, intent);
    }
  } catch (error) {
    intent.phase = error instanceof ManagedSwapRequestError && !error.outcomeUnknown
      ? "failed"
      : "outcome_unknown";
    intent.error = error instanceof Error ? error.message : String(error);
    saveEntry(intent);
  }

  return { intent };
}
