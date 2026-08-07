const API_BASE_URL = (process.env.SUWAPPU_API_URL ?? "https://api.suwappu.bot").replace(/\/$/, "");

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
  } = {},
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined) search.set(key, value);
  }
  const query = search.toString();
  const response = await fetch(
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

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Suwappu API error ${response.status}: ${text || response.statusText}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
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
    { params: { wallet_address: walletAddress, chain } },
  );

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
    { params: { symbols: symbols.join(","), chain } },
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
  });

  return {
    wouldExecute: data.would_execute === true,
    quoteId: data.quote_id ?? quoteId,
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
  try {
    response = await fetch(`${API_BASE_URL}/v1/agent/swap/execute`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ quote_id: quoteId }),
    });
  } catch (error) {
    throw new ManagedSwapRequestError(
      error instanceof Error ? error.message : String(error),
      { outcomeUnknown: true },
    );
  }

  const text = await response.text();
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
  } catch {}

  if (!response.ok) {
    throw new ManagedSwapRequestError(
      data.error ?? data.message ?? `Suwappu API error ${response.status}`,
      { httpStatus: response.status, outcomeUnknown: response.status >= 500 },
    );
  }

  if (data.swap_id === undefined || typeof data.status !== "string") {
    throw new ManagedSwapRequestError("Malformed managed swap response", {
      outcomeUnknown: true,
    });
  }

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
  }>(apiKey, "GET", `/v1/agent/swap/status/${encodeURIComponent(swapId)}`);

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
