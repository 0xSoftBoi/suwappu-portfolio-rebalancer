import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  RebalanceWriterLockError,
  runManagedExecution,
  withRebalanceWriterLock,
} from "../src/execution.js";
import { operationTimeoutMs } from "../src/suwappu.js";

const originalFetch = globalThis.fetch;
let stateDir = "";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "suwappu-rebalancer-test-"));
  process.env.SUWAPPU_REBALANCER_STATE_DIR = stateDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SUWAPPU_REBALANCER_STATE_DIR;
  delete process.env.SUWAPPU_OPERATION_TIMEOUT_MS;
  delete process.env.SUWAPPU_API_EVENTS;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("durable rebalance execution", () => {
  test("fails closed instead of forgetting an unreadable execution journal", async () => {
    writeFileSync(join(stateDir, "execution-journal.json"), "{not-json");
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return jsonResponse({});
    }) as unknown as typeof fetch;

    await expect(runManagedExecution({
      apiKey: "test",
      strategy: "rebalance",
      actionKey: "ETH-USDC",
      terms: { fromToken: "ETH", toToken: "USDC", amount: "0.1", chain: "base" },
      walletAddress: "0xabc",
      getQuote: async () => ({ id: "q", toAmount: "300" }),
    })).rejects.toThrow("refusing to replace durable state");
    expect(fetchCalls).toBe(0);
  });

  test("requires would_execute instead of treating an HTTP-success simulation as approval", async () => {
    let executeCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/swap/simulate")) {
        return jsonResponse({
          success: true,
          quote_id: "q-blocked",
          would_execute: false,
          warnings: ["balance check failed"],
        });
      }
      if (url.endsWith("/swap/execute")) executeCalls++;
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const result = await runManagedExecution({
      apiKey: "test",
      strategy: "rebalance",
      actionKey: "ETH-USDC",
      terms: { fromToken: "ETH", toToken: "USDC", amount: "0.1", chain: "base" },
      walletAddress: "0xabc",
      getQuote: async () => ({ id: "q-blocked", toAmount: "300" }),
    });

    expect(result.intent.phase).toBe("failed");
    expect(executeCalls).toBe(0);
  });

  test("reuses one idempotency key after an outcome-unknown network error", async () => {
    let executeCalls = 0;
    const keys: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/swap/simulate")) {
        return jsonResponse({ success: true, quote_id: "q", would_execute: true });
      }
      if (url.endsWith("/swap/execute")) {
        executeCalls++;
        keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        if (executeCalls === 1) throw new TypeError("connection reset after request");
        return jsonResponse({ swap_id: 17, status: "pending" });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const run = () => runManagedExecution({
      apiKey: "test",
      strategy: "rebalance",
      actionKey: "ETH-USDC",
      terms: { fromToken: "ETH", toToken: "USDC", amount: "0.1", chain: "base" },
      walletAddress: "0xabc",
      getQuote: async () => ({ id: `q-${executeCalls + 1}`, toAmount: "300" }),
    });

    const first = await run();
    expect(first.intent.phase).toBe("outcome_unknown");
    const second = await run();
    expect(second.intent.phase).toBe("submitted");
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  test("polls a known pending swap instead of submitting a replacement", async () => {
    let executeCalls = 0;
    let statusCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/swap/simulate")) return jsonResponse({ quote_id: "q", would_execute: true });
      if (url.endsWith("/swap/execute")) {
        executeCalls++;
        return jsonResponse({ swap_id: 22, status: "pending" });
      }
      if (url.endsWith("/swap/status/22")) {
        statusCalls++;
        return jsonResponse({ swap_id: 22, status: "pending" });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const run = () => runManagedExecution({
      apiKey: "test",
      strategy: "rebalance",
      actionKey: "ETH-USDC",
      terms: { fromToken: "ETH", toToken: "USDC", amount: "0.1", chain: "base" },
      walletAddress: "0xabc",
      getQuote: async () => ({ id: "q", toAmount: "300" }),
    });

    await run();
    const second = await run();
    expect(second.intent.phase).toBe("submitted");
    expect(executeCalls).toBe(1);
    expect(statusCalls).toBe(1);
  });

  test("uses final reconciled amounts rather than the quote as a fill", async () => {
    let status = "pending";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/swap/simulate")) return jsonResponse({ quote_id: "q", would_execute: true });
      if (url.endsWith("/swap/execute")) return jsonResponse({ swap_id: 33, status: "pending" });
      if (url.endsWith("/swap/status/33")) {
        return jsonResponse({
          swap_id: 33,
          status,
          from_amount: "0.1",
          to_amount: status === "completed" ? "297.5" : null,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const run = () => runManagedExecution({
      apiKey: "test",
      strategy: "rebalance",
      actionKey: "ETH-USDC",
      terms: { fromToken: "ETH", toToken: "USDC", amount: "0.1", chain: "base" },
      walletAddress: "0xabc",
      getQuote: async () => ({ id: "q", toAmount: "300" }),
    });

    const submitted = await run();
    expect(submitted.intent.actualToAmount).toBeUndefined();
    status = "completed";
    const completed = await run();
    expect(completed.intent.phase).toBe("completed");
    expect(completed.intent.quotedToAmount).toBe("300");
    expect(completed.intent.actualToAmount).toBe("297.5");
  });

  test("treats HTTP 408 during managed submission as outcome unknown", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/swap/simulate")) {
        return jsonResponse({ quote_id: "q-timeout", would_execute: true });
      }
      if (url.endsWith("/swap/execute")) {
        return jsonResponse({ error: "request timeout" }, 408);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const result = await runManagedExecution({
      apiKey: "test",
      strategy: "rebalance",
      actionKey: "ETH-USDC",
      terms: { fromToken: "ETH", toToken: "USDC", amount: "0.1", chain: "base" },
      walletAddress: "0xabc",
      getQuote: async () => ({ id: "q-timeout", toAmount: "300" }),
    });

    expect(result.intent.phase).toBe("outcome_unknown");
  });

  test("treats a malformed successful managed response as outcome unknown", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/swap/simulate")) {
        return jsonResponse({ quote_id: "q-malformed", would_execute: true });
      }
      if (url.endsWith("/swap/execute")) return jsonResponse({ status: "pending" });
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const result = await runManagedExecution({
      apiKey: "test",
      strategy: "rebalance",
      actionKey: "ETH-USDC",
      terms: { fromToken: "ETH", toToken: "USDC", amount: "0.1", chain: "base" },
      walletAddress: "0xabc",
      getQuote: async () => ({ id: "q-malformed", toAmount: "300" }),
    });

    expect(result.intent.phase).toBe("outcome_unknown");
  });

  test("fails closed when another live rebalance writer lock exists", async () => {
    writeFileSync(join(stateDir, "rebalance-live.lock"), "occupied");
    await expect(withRebalanceWriterLock(async () => "should-not-run"))
      .rejects.toBeInstanceOf(RebalanceWriterLockError);
  });

  test("rejects an invalid managed-operation timeout", () => {
    process.env.SUWAPPU_OPERATION_TIMEOUT_MS = "0";
    expect(() => operationTimeoutMs()).toThrow("between 100 and 30000");
  });

  test("metadata API events omit credentials and financial identifiers", async () => {
    process.env.SUWAPPU_API_EVENTS = "1";
    const events: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => events.push(args.map(String).join(" "));
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/swap/simulate")) {
        return jsonResponse({ quote_id: "secret-quote-id", would_execute: true });
      }
      if (url.endsWith("/swap/execute")) {
        return jsonResponse({ swap_id: "secret-swap-id", status: "pending" });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    try {
      await runManagedExecution({
        apiKey: "secret-api-key",
        strategy: "rebalance",
        actionKey: "ETH-USDC",
        terms: { fromToken: "ETH", toToken: "USDC", amount: "0.1", chain: "base" },
        walletAddress: "0xsecretwallet",
        getQuote: async () => ({ id: "secret-quote-id", toAmount: "300" }),
      });
    } finally {
      console.error = originalError;
    }

    expect(events.length).toBeGreaterThan(0);
    const output = events.join("\n");
    expect(output).not.toContain("secret-api-key");
    expect(output).not.toContain("0xsecretwallet");
    expect(output).not.toContain("secret-quote-id");
    expect(output).not.toContain("secret-swap-id");
  });
});
