# Suwappu Portfolio Rebalancer

A preview-by-default portfolio rebalancer built on [Suwappu](https://suwappu.bot).

Define target allocations, detect drift, inspect the exact USD rebalance plan, and only then opt into Suwappu managed-wallet execution with `--execute`.

> This is a builder example, not financial advice. Use a dedicated wallet, conservative wallet policies, and small limits while developing.

## Safety model

`rebalance` is now a preview command. Merely having an API key configured does not submit a transaction.

```bash
# Read portfolio + show drift
bun src/index.ts check

# Calculate the plan. No funds move.
bun src/index.ts rebalance

# Explicit live managed-wallet mode
bun src/index.ts rebalance --execute
```

The old `--dry-run` flag is accepted as a deprecated alias for preview mode, but preview is already the default.

Before every live swap this example:

1. expresses portfolio drift in USD;
2. fetches the source token's USD price and converts that USD intent to **source-token units** before requesting a quote;
3. requests a fresh Suwappu quote;
4. calls `/v1/agent/swap/simulate` for the configured wallet and aborts on a failed simulation;
5. submits the quote to the current managed-wallet `/v1/agent/swap/execute` pipeline.

That conversion in step 2 matters: a `$425` ETH rebalance must not be sent to the quote API as `425 ETH`.

## Quick start

```bash
git clone https://github.com/0xSoftBoi/suwappu-portfolio-rebalancer.git
cd suwappu-portfolio-rebalancer
bun install --frozen-lockfile

export SUWAPPU_API_KEY=suwappu_sk_...
export SUWAPPU_WALLET_ADDRESS=0xYourWallet

bun src/index.ts check
bun src/index.ts rebalance
```

Register a Suwappu agent if needed:

```bash
curl -X POST https://api.suwappu.bot/v1/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name":"my-rebalancer"}'
```

The wallet address is required by the current portfolio and simulation APIs. It is an address, never a private key.

## Strategy configuration

By default the example uses the built-in 50% ETH / 30% SOL / 20% USDC strategy on Arbitrum. For a custom strategy, create a strategy file:

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

Then point a rebalancer config at it:

```json
{
  "strategyPath": "strategy.json"
}
```

Run with:

```bash
bun src/index.ts check --config ./config.json
bun src/index.ts rebalance --config ./config.json
```

Prefer `SUWAPPU_API_KEY` and `SUWAPPU_WALLET_ADDRESS` environment variables over storing credentials or addresses in config files.

## Commands

| Command | Behavior |
|---|---|
| `check` | Read portfolio and show current vs target drift |
| `rebalance` | Calculate/print the plan only |
| `rebalance --execute` | Simulate and submit managed-wallet swaps |
| `config` | Show non-secret configuration; API key is never printed |

## Execution controls

| Variable | Default | Purpose |
|---|---:|---|
| `SUWAPPU_API_KEY` | required | Agent API key |
| `SUWAPPU_WALLET_ADDRESS` | required | Wallet used for portfolio lookup and simulation |
| `MAX_REBALANCE_USD` | `10000` | Maximum aggregate USD volume accepted by one live run |
| `SUWAPPU_API_URL` | production API | Optional API override for the current REST bridge |

`MAX_REBALANCE_USD` is a local defense in depth. Configure Suwappu wallet policies for the real server-side execution limits.

## SDK compatibility

The installable TypeScript dependency remains the published `@suwappu/sdk@0.4.x`. It is used for quote construction.

The `suwappubot` monorepo already contains newer 0.6.x SDK source for wallet-aware portfolio reads, `simulateSwap()`, managed `swap()`, self-custody `prepareSwap()`, policies, approvals, audit, and kill switches. Because 0.6.x is not yet published to npm, `src/suwappu.ts` isolates the current production REST calls this example needs.

Once the matching SDK package is released, the bridge can be replaced with those typed SDK methods.

## Supported networks

Suwappu currently exposes 14 supported chains. Query `list_chains` / the API at runtime rather than hard-coding chain counts into application logic.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

CI runs the same typecheck and tests as blocking checks. The tests include a regression for the USD-to-source-token conversion bug.

## Links

- [Suwappu docs](https://docs.suwappu.bot)
- [Published SDK](https://www.npmjs.com/package/@suwappu/sdk)
- [SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk)
- [Hosted MCP](https://api.suwappu.bot/mcp)

## License

[MIT](LICENSE)
