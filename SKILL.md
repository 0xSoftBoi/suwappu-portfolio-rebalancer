---
name: suwappu-rebalancer
description: Automated portfolio rebalancer — define target allocations, detect drift, and execute cross-chain rebalancing swaps
user-invocable: true
tools:
  - check_drift
  - rebalance
  - show_config
metadata:
  openclaw.requires.env: ["SUWAPPU_API_KEY"]
  openclaw.primaryEnv: SUWAPPU_API_KEY
  openclaw.emoji: "⚖️"
  openclaw.category: defi
  openclaw.tags: ["portfolio", "rebalance", "defi", "trading", "cross-chain"]
  openclaw.install:
    - type: npm
      package: "suwappu-portfolio-rebalancer"
---

# Suwappu Portfolio Rebalancer

Maintain target allocations across tokens and chains. When drift exceeds your threshold, the rebalancer calculates and executes the minimum swaps to bring your portfolio back to target.

## Setup

```bash
export SUWAPPU_API_KEY=suwappu_sk_...    # Get one free at POST https://api.suwappu.bot/v1/agent/register
```

## Tools

### check_drift
Show how far your portfolio has drifted from target allocations. Returns current vs target % for each token.

### rebalance
Calculate and execute swaps to bring portfolio back to target. Supports `--dry-run` to preview trades first.

### show_config
Display current target allocations, threshold, and chain.

## Typical Flow

1. Define targets: `{ "ETH": 50, "SOL": 30, "USDC": 20 }`
2. `check_drift` — see which tokens are over/under weight
3. `rebalance --dry-run` — preview the trades
4. `rebalance` — execute
