# Suwappu Portfolio Rebalancer

A preview-first **fixed-target rebalancing reference** built on [Suwappu](https://suwappu.bot). It shows how to turn managed-wallet balances into a deterministic drift plan, then cross the live execution boundary with simulation, durable idempotency, reconciliation, and final-amount accounting.

> This is builder infrastructure, not financial advice or a portfolio optimizer. Example target weights are arbitrary. Evaluate the allocation policy your users actually need before putting capital behind it.

## Why this repo exists

The useful part to copy is the boundary between **portfolio policy** and **financial action**:

```text
managed portfolio -> normalized holdings -> drift -> preview plan
                  -> explicit --execute -> quote -> simulate
                  -> persist intent -> submit -> reconcile -> final amounts
```

Flywheel covers multi-strategy composition; this repository stays narrow so a builder can see one target-allocation workflow end to end.

### Where it fits vs mature OSS

Do not turn this example into a home-grown quantitative research platform.

| Need | This repo | Better reference when the need is deeper |
|---|---|---|
| Suwappu managed-wallet portfolio + rebalance execution contract | Primary purpose | — |
| Fixed target weights + drift threshold | Included | — |
| Mean/semivariance, Black-Litterman, HRP, optimizer constraints | Not included | [PyPortfolioOpt](https://pyportfolioopt.readthedocs.io/) |
| Full algorithm framework, scheduled portfolio construction, brokerage/reality models | Not included | [LEAN](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/portfolio-construction/key-concepts) |
| Historical tax lots / tax-aware optimization | Not included | Add a purpose-built accounting/optimization layer |
| Distributed execution ledger | Local reference journal | Move the state machine to your transactional database |

The differentiation here is not a better optimizer. It is a compact Suwappu-specific example for safely turning an allocation decision into a managed-wallet outcome.

## Safe start

```bash
git clone https://github.com/0xSoftBoi/suwappu-portfolio-rebalancer.git
cd suwappu-portfolio-rebalancer
bun install --frozen-lockfile

export SUWAPPU_API_KEY=suwappu_sk_...
export SUWAPPU_WALLET_ADDRESS=0xYourManagedWallet

# Read only.
bun src/index.ts check

# Plan only. No funds move.
bun src/index.ts rebalance
```

`SUWAPPU_WALLET_ADDRESS` must be the managed wallet belonging to the authenticated agent. The current portfolio endpoint rejects arbitrary third-party addresses. It is an address, never a private key.

Create a managed wallet if needed:

```bash
curl -X POST https://api.suwappu.bot/v1/agent/wallets \
  -H "Authorization: Bearer $SUWAPPU_API_KEY"
```

## What a rebalance means

The default example policy is deliberately simple: **50% ETH / 50% USDC on Base, with a 5 percentage-point drift threshold**.

For a custom policy, create `strategy.json`:

```json
{
  "allocations": {
    "ETH": 60,
    "USDC": 40
  },
  "threshold": 5,
  "chain": "base"
}
```

Then point a rebalancer config at it:

```json
{
  "strategyPath": "strategy.json"
}
```

```bash
bun src/index.ts check --config ./config.json
bun src/index.ts rebalance --config ./config.json
```

The planner has explicit semantics:

1. aggregate duplicate symbol rows case-insensitively;
2. include every returned holding in total portfolio USD value;
3. surface any holding absent from the target map as **UNCONFIGURED** and refuse to create a rebalance plan until the user decides what it means;
4. require an explicit `0` target if liquidation of an existing holding is intended;
5. if no configured asset drifts beyond the threshold, do nothing; and
6. once the threshold is breached, pair all positive/negative dollar gaps toward the exact target weights.

The explicit-zero rule prevents a surprise token, airdrop, or manually held asset from becoming an accidental sell authorization. The final rule avoids a different common failure: one asset can be +10 points overweight while two assets are each -5 points underweight. Looking only for deficits that independently exceed a 5-point threshold produces no executable plan even though the configured portfolio is clearly outside policy.

The planner does not decide whether 60/40, 50/50, or any other allocation is sensible. That policy belongs to your product/research layer.

## Live execution is an explicit capability

Only `--execute` crosses the managed-wallet boundary:

```bash
export MAX_REBALANCE_USD=100
bun src/index.ts rebalance --execute
```

For each planned swap the live path:

1. converts the planned USD value to source-token units using the current USD price;
2. requests a fresh Suwappu quote;
3. requires `POST /v1/agent/swap/simulate` to return `would_execute=true` for the configured managed wallet;
4. persists a durable economic intent and server-compatible `Idempotency-Key` **before** submission;
5. submits through `POST /v1/agent/swap/execute`;
6. reconciles a known `swap_id` through `GET /v1/agent/swap/status/:id`; and
7. only reports a trade as completed when terminal status provides final input/output amounts; and
8. stops after that one economic action so the next live invocation starts from a fresh portfolio instead of a stale multi-trade batch.

An HTTP-successful simulation is not enough: `success=true` can coexist with `would_execute=false`. The example checks the latter.

If execution times out, loses its connection, or returns a 5xx after a side effect may have started, the outcome is unknown. The next explicit `--execute` resumes the **same persisted intent and idempotency key**; a known `swap_id` is polled rather than resubmitted. The rebalancer will not plan a new economic action while that intent remains unresolved.

Inspect the journal without creating an action:

```bash
bun src/index.ts executions
bun src/index.ts executions --reconcile
```

`--reconcile` only polls known swap IDs. It never submits a trade.

## Commands

| Command | Authority |
|---|---|
| `check` | Managed-wallet portfolio read only |
| `rebalance` | Portfolio read + deterministic local plan |
| `rebalance --execute` | Explicit managed execution; stops on unresolved finality |
| `executions` | Read local execution journal |
| `executions --reconcile` | Read/poll known swap IDs only |
| `config` | Show non-secret policy/configuration; API key remains hidden |

The legacy `--dry-run` flag is accepted only as a deprecated preview alias. Preview is already the default.

## Execution controls

| Variable | Default | Purpose |
|---|---:|---|
| `SUWAPPU_API_KEY` | required | Agent API key |
| `SUWAPPU_WALLET_ADDRESS` | required | Authenticated agent's managed wallet |
| `MAX_REBALANCE_USD` | `1000` | Maximum USD value for the next live rebalance action; invalid values fail closed |
| `SUWAPPU_REBALANCER_STATE_DIR` | `~/.suwappu-rebalancer` | Durable local execution journal location |
| `SUWAPPU_API_URL` | production API | Optional API override applied consistently to SDK quotes and the REST execution bridge |

`MAX_REBALANCE_USD` is only defense in depth. Configure server-side wallet policies, approvals, and a kill switch for real limits.

The JSON journal is a single-process reference. A paid multi-worker service needs transactional persistence, a unique economic-intent constraint, locking/leases, and an append-only audit trail.

Run only one live rebalancer process per local state directory. The reference JSON journal is deliberately not a cross-process lock.

## Important limitations

- Portfolio USD values and token prices are current snapshots, not a historical accounting system.
- The example does not optimize risk/return, taxes, turnover, gas, or slippage when selecting target weights.
- It does not model LP positions, debt, staking claims, tax lots, or assets the portfolio endpoint does not return.
- It does not backtest an allocation policy. Use historical/walk-forward evaluation before automating one.
- A fixed drift threshold reduces unnecessary actions; it does not make a target allocation profitable.

For product-grade strategy promotion, follow the [Suwappu Strategy Lifecycle](https://suwappu.bot/docs/guides/strategy-lifecycle.md).

## Build something people pay for

The lower-risk product path is usually **monitoring before automation**:

1. sell a treasury/allocation drift report or alert;
2. add saved policies, history, exports, and team approval workflows;
3. add quote + simulation previews;
4. add policy-bounded managed execution only when customers ask for it.

[`BUILDING_A_PRODUCT.md`](BUILDING_A_PRODUCT.md) turns this into concrete MVPs, activation/retention metrics, and a contribution-margin ledger. Product revenue and a customer's portfolio P&L are separate scoreboards.

## SDK compatibility

This repository currently depends on `@suwappu/sdk@^0.4.0` for the installable quote contract. The core repository contains newer SDK source with typed managed execution, simulation, portfolio, policy, approval, audit, and kill-switch helpers.

Until the matching package version is published, `src/suwappu.ts` keeps the current REST money-moving/reconciliation contract isolated from the older installed SDK. Verify the version you actually deploy instead of copying an unpublished method into production.

## Network and token discovery

Do not hard-code chain counts or assume a symbol is tradable on every chain. Ask `GET /v1/agent/chains` and `GET /v1/agent/tokens?chain=<key>` at runtime when building a configurable product.

The default policy uses the common ETH/USDC pair on Base so the example does not imply that Solana's native `SOL` exists on an EVM chain.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

Regression coverage includes production drift math, unexpected holdings, threshold funding, invalid live caps, `would_execute`, idempotent outcome-unknown retry, known-swap no-resubmit behavior, and quote-vs-final amount separation.

## Links

- [Suwappu docs](https://suwappu.bot/docs)
- [Published TypeScript SDK](https://www.npmjs.com/package/@suwappu/sdk)
- [SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk)
- [PyPortfolioOpt](https://pyportfolioopt.readthedocs.io/)
- [LEAN portfolio construction](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/portfolio-construction/key-concepts)

## License

[MIT](LICENSE)
