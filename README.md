# Suwappu Portfolio Rebalancer

A standalone, preview-first **treasury drift monitor and fixed-target rebalancer** built on [Suwappu](https://suwappu.bot). Run it as a local/operator product for policy monitoring and controlled managed-wallet rebalancing, or use its narrow state machine as a reference when building a larger service.

> This is builder infrastructure, not financial advice or a portfolio optimizer. Example target weights are arbitrary. Evaluate the allocation policy your users actually need before putting capital behind it.

## What the product does

The useful part to copy is the boundary between **portfolio policy** and **financial action**:

```text
managed portfolio -> normalized holdings -> drift -> preview plan
                  -> explicit --execute -> quote -> simulate
                  -> persist intent -> submit -> reconcile -> final amounts
```

In addition to the preview/live boundary, v2 provides machine-readable drift checks, durable bounded snapshot history, policy fingerprints, a full-cycle single-writer live lock, persistent container state, bounded managed API calls, dependency/code scanning, and an operator runbook. Flywheel covers multi-strategy composition; this product stays deliberately narrow around treasury policy.

### Where it fits vs mature OSS

Do not turn this example into a home-grown quantitative research platform.

| Need | This repo | Better reference when the need is deeper |
|---|---|---|
| Suwappu managed-wallet portfolio + rebalance execution contract | Primary purpose | — |
| Fixed target weights + drift threshold, history, automation output | Included | — |
| Transaction/churn guard | Optional minimum USD leg; explicit live cap | Use a real fee/slippage model for optimization |
| Mean/semivariance, Black-Litterman, HRP, optimizer constraints | Not included | [PyPortfolioOpt](https://pyportfolioopt.readthedocs.io/) |
| Full algorithm framework, scheduled portfolio construction, brokerage/reality models | Not included | [LEAN](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/portfolio-construction/key-concepts) |
| Historical tax lots / tax-aware optimization | Not included | Add a purpose-built accounting/optimization layer |
| Distributed execution ledger | Durable single-writer local journal | Move the state machine to your transactional database |

PyPortfolioOpt exposes an explicit [transaction-cost objective](https://pyportfolioopt.readthedocs.io/en/latest/MeanVariance.html), while LEAN's [position sizing](https://www.quantconnect.com/docs/v2/writing-algorithms/trading-and-orders/position-sizing) accounts for details such as lot size and pre-calculated fees. Do not imply this rebalancer has either system's research or reality-model breadth. Its differentiation is the compact Suwappu policy -> evidence -> approval -> financial-intent -> reconciliation path.

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

## Run it as a drift monitor

`check` can be an automation contract rather than a terminal-only report:

```bash
# JSON only on stdout. Record the observation locally.
bun src/index.ts check --json --record

# Also set exit code 2 when a configured threshold is breached or an
# unconfigured holding creates a policy exception.
bun src/index.ts check --json --record --fail-on-drift

# Inspect the newest recorded observations without an API call.
bun src/index.ts history --limit 20
bun src/index.ts history --json --limit 100
```

Snapshots contain a stable policy fingerprint and a one-way wallet reference, not the API key or full wallet address. `SUWAPPU_REBALANCER_HISTORY_LIMIT` bounds retained local observations (default 5000). Use your scheduler, alerting system, or workflow platform around the one-shot command; do not hide live execution inside a generic restart loop.

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

An explicitly supplied config file must exist. A custom strategy must explicitly define `allocations`, `threshold`, and `chain`; v2 does not merge a partial policy with the built-in 50/50 default. Relative `strategyPath` values resolve from the config file's directory. This makes a typo fail closed instead of silently changing a live policy.

The planner has explicit semantics:

1. aggregate duplicate symbol rows case-insensitively;
2. include every returned holding in total portfolio USD value;
3. surface any holding absent from the target map as **UNCONFIGURED** and refuse to create a rebalance plan until the user decides what it means;
4. require an explicit `0` target if liquidation of an existing holding is intended;
5. if no configured asset drifts beyond the threshold, do nothing; and
6. once the threshold is breached, pair all positive/negative dollar gaps toward the exact target weights.

The explicit-zero rule prevents a surprise token, airdrop, or manually held asset from becoming an accidental sell authorization. The final rule avoids a different common failure: one asset can be +10 points overweight while two assets are each -5 points underweight. Looking only for deficits that independently exceed a 5-point threshold produces no executable plan even though the configured portfolio is clearly outside policy.

The planner does not decide whether 60/40, 50/50, or any other allocation is sensible. That policy belongs to your product/research layer.

Set `MIN_REBALANCE_USD` when you want to suppress small planned legs that are operationally uneconomic. It is a notional floor, **not** a gas/slippage/fee model. When the drift threshold is breached but every leg is below the floor, the CLI reports that condition and takes no action instead of claiming the portfolio is in range.

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

If execution times out, loses its connection, returns HTTP 408/5xx, or produces a malformed successful response after a side effect may have started, the outcome is unknown. The next explicit `--execute` resumes the **same persisted intent and idempotency key**; a known `swap_id` is polled rather than resubmitted. The rebalancer will not plan a new economic action while that intent remains unresolved.

The CLI holds `rebalance-live.lock` across the entire live cycle—resume, fresh portfolio read, planning, submit/reconcile, and accounting—so a second local writer cannot prepare a stale concurrent plan. `executions --reconcile` takes the same lock so reconciliation cannot race a live writer. After an abnormal death, stop schedulers, inspect the journal read-only, prove the lock is stale, clear only that stale lock, then reconcile **before** re-enabling live work; see [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

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
| `history` | Read locally recorded drift-monitor snapshots; no API call |
| `config` | Show non-secret policy/configuration; API key remains hidden |

The legacy `--dry-run` flag is accepted only as a deprecated preview alias. Preview is already the default.

## Execution controls

| Variable | Default | Purpose |
|---|---:|---|
| `SUWAPPU_API_KEY` | required | Agent API key |
| `SUWAPPU_WALLET_ADDRESS` | required | Authenticated agent's managed wallet |
| `MAX_REBALANCE_USD` | `1000` | Maximum USD value for the next live rebalance action; invalid values fail closed |
| `MIN_REBALANCE_USD` | `0` | Optional minimum planned leg; invalid values fail closed |
| `SUWAPPU_REBALANCER_STATE_DIR` | `~/.suwappu-rebalancer` | Durable local execution journal location |
| `SUWAPPU_REBALANCER_HISTORY_LIMIT` | `5000` | Maximum retained drift snapshots |
| `SUWAPPU_OPERATION_TIMEOUT_MS` | `25000` | Direct REST deadline; valid range 100–30000 ms |
| `SUWAPPU_API_EVENTS` | off | Metadata-only operation/outcome/duration/status events on stderr |
| `SUWAPPU_API_URL` | production API | Optional API override applied consistently to SDK quotes and the REST execution bridge |

`MAX_REBALANCE_USD` is only defense in depth. Configure server-side wallet policies, approvals, and a kill switch for real limits.

Local state uses fail-closed JSON loading, restrictive permissions, file fsync, atomic rename, and best-effort directory fsync. Existing corrupt financial or monitor state is never silently replaced with an empty ledger.

The live lock makes the supported local deployment single-writer. A paid multi-worker service still needs transactional persistence, a unique economic-intent constraint, locking/leases, and an append-only audit trail.

## Container deployment

The image runs as the non-root `bun` user and Compose persists `/data` in the `rebalancer_state` named volume:

```bash
cp .env.example .env
# Fill the API key and managed-wallet address in .env.
docker compose run --rm rebalancer
```

The default container command performs one read-only `check --record`; it never executes a swap. `--rm` removes the container but not the named state volume. Back up that volume before live upgrades and do not delete it while an intent is unresolved.

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

CI additionally builds the CLI, checks its help contract, audits high/critical dependency advisories, validates/builds the container, and runs CodeQL. The supported operational boundary and live-money recovery procedure are in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Links

- [Suwappu docs](https://suwappu.bot/docs)
- [Published TypeScript SDK](https://www.npmjs.com/package/@suwappu/sdk)
- [SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk)
- [PyPortfolioOpt](https://pyportfolioopt.readthedocs.io/)
- [LEAN portfolio construction](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/portfolio-construction/key-concepts)

## License

[MIT](LICENSE)
