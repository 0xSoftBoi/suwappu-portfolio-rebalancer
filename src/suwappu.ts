const API_BASE_URL = (process.env.SUWAPPU_API_URL ?? "https://api.suwappu.bot").replace(/\/$/, "");
const DEFAULT_OPERATION_TIMEOUT_MS = 25_000;
const MAX_OPERATION_TIMEOUT_MS = 30_000;

export function operationTimeoutMs(): number {
  const raw = process.env.SUWAPPU_OPERATION_TIMEOUT_MS ?? String(DEFAULT_OPERATION_TIMEOUT_MS);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 100 || value > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error("SUWAPPU_OPERATION_TIMEOUT_MS must be between 100 and 30000 milliseconds");
  }
  return value;
}

type ApiOutcome = "success" | "http_error" | "protocol_error" | "timeout" | "network_error";

function emitApiEvent(
  operation: string,
  outcome: ApiOutcome,
  startedAt: number,
  status?: number,
): void {
  if (!/^(1|true)$/i.test(process.env.SUWAPPU_API_EVENTS ?? "")) return;
  const event: Record<string, string | number> = {
    operation,
    outcome,
    duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
  };
  if (status !== undefined) event.status = status;
  // Deliberately omit credentials, wallet/quote/swap IDs, policy inputs,
  // request/response bodies, and error messages.
  console.error(`suwappu_api_event ${JSON.stringify(event)}`);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
}

async function fetchWithDeadline(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(operationTimeoutMs()),
  });
}

/** Bound an SDK/read promise that does not expose an AbortSignal hook. */
export async function withOperationDeadline<T>(
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${operation} timed out`);
          error.name = "TimeoutError";
          reject(error);
        }, operationTimeoutMs());
      }),
    ]);
    emitApiEvent(operation, "success", startedAt);
    return result;
  } catch (error) {
    const timeout = isTimeoutError(error);
    emitApiEvent(operation, timeout ? "timeout" : "network_error", startedAt);
    throw new Error(`${operation} ${timeout ? "timed out" : "failed"}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface PortfolioBalance {
  token: string;
  balance: string;
  usdValue: string;
  chain: string;
}

export interface SwapSimulation {
  wouldExecute: boolean;
  quoteId: string;
  warnings: string[];
  checks: Array<{ name: string; status: string; detail: string }>;
}

export interface ManagedSwapResult {
  swapId: string;
  status: string;
  txHash?: string;
  pollUrl?: string;
}

export interface ManagedSwapStatus {
  swapId: string;
  status: string;
  txHash?: string;
  fromAmount?: string;
  toAmount?: string;
  errorMessage?: string;
}

export class ManagedSwapRequestError extends Error {
  readonly httpStatus?: number;
  readonly outcomeUnknown: boolean;

  constructor(message: string, options: { httpStatus?: number; outcomeUnknown?: boolean } = {}) {
    super(message);
    this.name = "ManagedSwapRequestError";
    this.httpStatus = options.httpStatus;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

async function request<T>(
  apiKey: string,
  method: string,
  path: string,
  options: {
    params?: Record<string, string | undefined>;
    json?: unknown;
    operation?: string;
  } = {},
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined) search.set(key, value);
  }
  const query = search.toString();
  const operation = options.operation ?? "api_request";
  const startedAt = performance.now();
  let response: Response;
  let text: string;
  try {
    response = await fetchWithDeadline(
      `${API_BASE_URL}${path}${query ? `?${query}` : ""}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
      },
    );
    text = await response.text();
  } catch (error) {
    const timeout = isTimeoutError(error);
    emitApiEvent(operation, timeout ? "timeout" : "network_error", startedAt);
    throw new Error(`${operation} ${timeout ? "timed out" : "transport failed"}`);
  }

  if (!response.ok) {
    emitApiEvent(operation, "http_error", startedAt, response.status);
    throw new Error(`${operation} failed with Suwappu API status ${response.status}`);
  }
  try {
    const parsed = (text ? JSON.parse(text) : {}) as T;
    emitApiEvent(operation, "success", startedAt, response.status);
    return parsed;
  } catch {
    emitApiEvent(operation, "protocol_error", startedAt, response.status);
    throw new Error(`${operation} returned malformed JSON`);
  }
}

export async function getPortfolio(
  apiKey: string,
  walletAddress: string,
  chain?: string,
): Promise<PortfolioBalance[]> {
  const data = await request<{ balances?: Array<Record<string, unknown>> }>(
    apiKey,
    "GET",
    "/v1/agent/portfolio",
    { params: { wallet_address: walletAddress, chain }, operation: "get_portfolio" },
  );

  if (!Array.isArray(data.balances)) {
    throw new Error("get_portfolio returned a malformed balances payload");
  }

  return (data.balances ?? []).map((balance) => ({
    token: String(balance.symbol ?? balance.token ?? ""),
    balance: String(balance.balance ?? "0"),
    usdValue: String(balance.usd_value ?? balance.usdValue ?? "0"),
    chain: String(balance.chain ?? chain ?? ""),
  }));
}

export async function getPrices(
  apiKey: string,
  symbols: string[],
  chain?: string,
): Promise<Record<string, number>> {
  const data = await request<{ prices?: Record<string, { usd?: string | number }> }>(
    apiKey,
    "GET",
    "/v1/agent/prices",
    { params: { symbols: symbols.join(","), chain }, operation: "get_prices" },
  );

  return Object.fromEntries(
    Object.entries(data.prices ?? {})
      .map(([symbol, info]) => [symbol.toUpperCase(), Number(info.usd)] as const)
      .filter(([, price]) => Number.isFinite(price) && price > 0),
  );
}

export async function simulateManagedSwap(
  apiKey: string,
  quoteId: string,
  walletAddress: string,
): Promise<SwapSimulation> {
  const data = await request<{
    quote_id?: string;
    would_execute?: boolean;
    warnings?: unknown[];
    checks?: Array<{ name?: unknown; status?: unknown; detail?: unknown }>;
  }>(apiKey, "POST", "/v1/agent/swap/simulate", {
    json: { quote_id: quoteId, wallet_address: walletAddress },
    operation: "simulate_swap",
  });

  if (typeof data.would_execute !== "boolean" || typeof data.quote_id !== "string") {
    throw new ManagedSwapRequestError("Malformed swap simulation response");
  }

  return {
    wouldExecute: data.would_execute,
    quoteId: data.quote_id,
    warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : [],
    checks: Array.isArray(data.checks)
      ? data.checks.map((check) => ({
          name: String(check.name ?? ""),
          status: String(check.status ?? ""),
          detail: String(check.detail ?? ""),
        }))
      : [],
  };
}

export async function executeManagedSwap(
  apiKey: string,
  quoteId: string,
  { idempotencyKey }: { idempotencyKey: string },
): Promise<ManagedSwapResult> {
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(idempotencyKey)) {
    throw new Error("idempotencyKey must be 1-64 characters using A-Z, a-z, 0-9, _, ., :, or -");
  }

  let response: Response;
  let text: string;
  const startedAt = performance.now();
  try {
    response = await fetchWithDeadline(`${API_BASE_URL}/v1/agent/swap/execute`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ quote_id: quoteId }),
    });
    text = await response.text();
  } catch (error) {
    const timeout = isTimeoutError(error);
    emitApiEvent("execute_managed_swap", timeout ? "timeout" : "network_error", startedAt);
    throw new ManagedSwapRequestError(
      `Managed swap ${timeout ? "timed out" : "transport failed"}`,
      { outcomeUnknown: true },
    );
  }

  let data: {
    swap_id?: string | number;
    status?: string;
    tx_hash?: string | null;
    tracking?: { poll_url?: string };
    error?: string;
    message?: string;
  } = {};
  try {
    data = text ? JSON.parse(text) as typeof data : {};
  } catch {
    if (response.ok) {
      emitApiEvent("execute_managed_swap", "protocol_error", startedAt, response.status);
      throw new ManagedSwapRequestError("Malformed managed swap response", {
        outcomeUnknown: true,
      });
    }
  }

  if (!response.ok) {
    emitApiEvent("execute_managed_swap", "http_error", startedAt, response.status);
    throw new ManagedSwapRequestError(
      `Managed swap failed with Suwappu API status ${response.status}`,
      {
        httpStatus: response.status,
        outcomeUnknown: response.status === 408 || response.status >= 500,
      },
    );
  }

  if (data.swap_id === undefined || typeof data.status !== "string") {
    emitApiEvent("execute_managed_swap", "protocol_error", startedAt, response.status);
    throw new ManagedSwapRequestError("Malformed managed swap response", {
      outcomeUnknown: true,
    });
  }

  emitApiEvent("execute_managed_swap", "success", startedAt, response.status);

  return {
    swapId: String(data.swap_id),
    status: data.status,
    ...(data.tx_hash ? { txHash: data.tx_hash } : {}),
    ...(data.tracking?.poll_url ? { pollUrl: data.tracking.poll_url } : {}),
  };
}

export function isSuccessfulSwapStatus(status: string): boolean {
  return ["completed", "confirmed"].includes(status.toLowerCase());
}

export function isFailedSwapStatus(status: string): boolean {
  return status.toLowerCase() === "failed";
}

export async function getManagedSwapStatus(
  apiKey: string,
  swapId: string,
): Promise<ManagedSwapStatus> {
  const data = await request<{
    swap_id?: string | number;
    status?: string;
    tx_hash?: string | null;
    from_amount?: string;
    to_amount?: string | null;
    error_message?: string | null;
  }>(apiKey, "GET", `/v1/agent/swap/status/${encodeURIComponent(swapId)}`, {
    operation: "get_swap_status",
  });

  if (data.swap_id === undefined || typeof data.status !== "string") {
    throw new Error("Malformed managed swap status response");
  }
  return {
    swapId: String(data.swap_id),
    status: data.status,
    ...(data.tx_hash ? { txHash: data.tx_hash } : {}),
    ...(data.from_amount ? { fromAmount: data.from_amount } : {}),
    ...(data.to_amount ? { toAmount: data.to_amount } : {}),
    ...(data.error_message ? { errorMessage: data.error_message } : {}),
  };
}
