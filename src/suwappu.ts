const API_BASE_URL = (process.env.SUWAPPU_API_URL ?? "https://api.suwappu.bot").replace(/\/$/, "");

export interface PortfolioBalance {
  token: string;
  balance: string;
  usdValue: string;
  chain: string;
}

export interface SwapSimulation {
  success: boolean;
  reason?: string;
  gasEstimate?: string;
  amountOut?: string;
  [key: string]: unknown;
}

export interface ManagedSwapResult {
  swapId: string;
  status: string;
  txHash?: string;
  pollUrl?: string;
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

export function simulateSwap(
  apiKey: string,
  quoteId: string,
  walletAddress: string,
): Promise<SwapSimulation> {
  return request(apiKey, "POST", "/v1/agent/swap/simulate", {
    json: { quote_id: quoteId, wallet_address: walletAddress },
  });
}

export async function executeManagedSwap(
  apiKey: string,
  quoteId: string,
): Promise<ManagedSwapResult> {
  const data = await request<{
    swap_id?: string | number;
    status?: string;
    tx_hash?: string | null;
    tracking?: { poll_url?: string };
  }>(apiKey, "POST", "/v1/agent/swap/execute", {
    json: { quote_id: quoteId },
  });

  if (data.swap_id === undefined || typeof data.status !== "string") {
    throw new Error("Malformed managed swap response");
  }

  return {
    swapId: String(data.swap_id),
    status: data.status,
    ...(data.tx_hash ? { txHash: data.tx_hash } : {}),
    ...(data.tracking?.poll_url ? { pollUrl: data.tracking.poll_url } : {}),
  };
}
