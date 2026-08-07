import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runManagedExecution } from "../src/execution.js";

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
    })).rejects.toThrow("refusing to create a new economic action");
    expect(fetchCalls).toBe(0);
  });

  test("requires would_execute instead of treating an HTTP-success simulation as approval", async () => {
    let executeCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/swap/simulate")) {
        return jsonResponse({
          success: true,
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
        return jsonResponse({ success: true, would_execute: true });
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
      if (url.endsWith("/swap/simulate")) return jsonResponse({ would_execute: true });
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
      if (url.endsWith("/swap/simulate")) return jsonResponse({ would_execute: true });
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
});
