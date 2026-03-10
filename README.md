# suwappu-portfolio-rebalancer

**Automated portfolio rebalancer for the [Suwappu](https://suwappu.bot) cross-chain DEX.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org)
[![Suwappu SDK](https://img.shields.io/badge/Suwappu_SDK-0.5.0-purple.svg)](https://www.npmjs.com/package/@suwappu/sdk)

Define target allocations (e.g. 50% ETH, 30% SOL, 20% USDC), set a drift threshold, and let the rebalancer calculate and execute the minimum swaps to bring your portfolio back to target — across any of 15 supported chains.

---

## Features

- **Target allocations** — Specify exact percentage targets for each token
- **Drift detection** — Automatically identifies when positions deviate beyond your threshold
- **Minimum trades** — Calculates the fewest swaps needed to rebalance
- **Dry run mode** — Preview all trades before executing
- **Cross-chain** — Works on Ethereum, Arbitrum, Base, Solana, and 11 more networks
- **OpenClaw compatible** — Includes SKILL.md for AI agent discovery

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/0xSoftBoi/suwappu-portfolio-rebalancer.git
cd suwappu-portfolio-rebalancer

# 2. Install
bun install

# 3. Get a free API key
curl -X POST https://api.suwappu.bot/v1/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name": "my-rebalancer"}'

# 4. Set your key
export SUWAPPU_API_KEY=suwappu_sk_...

# 5. Check drift
bun src/index.ts check

# 6. Preview trades
bun src/index.ts rebalance --dry-run

# 7. Execute
bun src/index.ts rebalance
```

---

## Configuration

Create a strategy file at `~/.suwappu-rebalancer/config.json` or pass `--config path/to/config.json`:

```json
{
  "allocations": {
    "ETH": 50,
    "SOL": 30,
    "USDC": 20
  },
  "threshold": 5,
  "chain": "arbitrum"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `allocations` | `Record<string, number>` | Target % per token. Must sum to 100. |
| `threshold` | `number` | Minimum drift % before rebalancing triggers. Default: `5` |
| `chain` | `string` | Chain to execute swaps on. Default: `"arbitrum"` |
| `rebalanceInterval` | `string` | Optional. `"daily"`, `"weekly"`, `"hourly"` (informational) |

---

## Commands

| Command | Description |
|---------|-------------|
| `check` | Show current portfolio vs targets, highlight drift |
| `rebalance` | Calculate and execute rebalancing swaps |
| `rebalance --dry-run` | Preview trades without executing |
| `config` | Display current configuration and allocations |

### Options

| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Path to strategy config file |
| `--dry-run` | Preview only, don't execute trades |

---

## Example Output

```
Portfolio Drift Report
──────────────────────────────────────────────────
  ETH      62.3% → target 50%  (drift: 12.3%)
  SOL      21.5% → target 30%  (drift: -8.5%)
  USDC     16.2% → target 20%  (drift: -3.8%)

Rebalance needed (threshold: 5%)
```

```
Planned Trades:
  ETH → SOL: $425.00 on arbitrum
  ETH → USDC: $190.00 on arbitrum
```

---

## How It Works

1. **Fetch** — Pulls your current portfolio from the Suwappu API
2. **Calculate drift** — Compares actual allocations to your targets
3. **Plan trades** — Finds the minimum set of swaps to correct the drift
4. **Execute** — Routes swaps through Suwappu's aggregated liquidity (Li.Fi, Jupiter, CoW, Wormhole)

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUWAPPU_API_KEY` | Yes | Your Suwappu API key. Get one free at `POST https://api.suwappu.bot/v1/agent/register` |

---

## OpenClaw / AI Agent Integration

This project includes a `SKILL.md` for [OpenClaw](https://openclaw.com) discovery. AI agents can discover and use the rebalancer as a skill.

---

## License

[MIT](LICENSE)
