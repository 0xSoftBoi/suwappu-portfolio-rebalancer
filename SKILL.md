---
name: suwappu-rebalancer
description: Preview-by-default fixed-target Suwappu rebalancer — detect drift, plan trades, and explicitly opt into outcome-safe managed execution
user-invocable: true
tools:
  - check_drift
  - rebalance
  - show_config
metadata:
  openclaw.requires.env: ["SUWAPPU_API_KEY", "SUWAPPU_WALLET_ADDRESS"]
  openclaw.primaryEnv: SUWAPPU_API_KEY
  openclaw.emoji: "⚖️"
  openclaw.category: defi
  openclaw.tags: ["portfolio", "rebalance", "defi", "trading", "cross-chain"]
---

# Suwappu Portfolio Rebalancer

Maintain fixed target allocations with a visible execution boundary. The default `rebalance` action calculates and displays a plan; it never submits swaps. Holdings absent from the target policy are surfaced as unconfigured and block planning until the user explicitly assigns a target (including `0` when liquidation is intentional).

## Setup

```bash
export SUWAPPU_API_KEY=suwappu_sk_...
export SUWAPPU_WALLET_ADDRESS=0xYourWallet
```

## Tools

### check_drift

Read the configured wallet portfolio and show current vs target allocation drift.

### rebalance

Calculate and display the minimum rebalance plan. Preview is the default.

### show_config

Display non-secret configuration. The API key is not printed.

## Typical flow

1. Define target allocations.
2. Run `check_drift`.
3. Run `rebalance` and review the USD plan.
4. Configure wallet policies and host approval.
5. Only then run `rebalance --execute`; each quote must return `would_execute=true`, then the intent is persisted before managed submission.
6. Reconcile `swap_id` to a terminal result before treating it as completed or planning another action.

A planned USD value is converted to source-token units before quoting. Never treat a dollar amount as if it were an ETH/SOL/token quantity.

Use `executions --reconcile` to poll known swap IDs without submitting a replacement action. Timeout/network/5xx failures after managed submission begins can have an unknown outcome; keep the persisted idempotency key and reconcile first.
