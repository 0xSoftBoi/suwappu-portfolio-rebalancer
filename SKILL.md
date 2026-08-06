---
name: suwappu-rebalancer
description: Preview-by-default Suwappu portfolio rebalancer — detect drift, plan trades, simulate, and explicitly opt into managed execution
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

Maintain target allocations with a visible execution boundary. The default `rebalance` action calculates and displays a plan; it never submits swaps.

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
5. Only then run `rebalance --execute`; each quote is simulated before managed execution.

A planned USD value is converted to source-token units before quoting. Never treat a dollar amount as if it were an ETH/SOL/token quantity.
