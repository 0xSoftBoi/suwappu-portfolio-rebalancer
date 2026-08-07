# Build a Paid Portfolio Workflow, Not a Return Promise

The rebalancer is most useful as a product primitive: **policy + evidence + controlled action + audit**. Customers can pay for that workflow even though no allocation policy can promise positive returns.

Keep two questions separate:

1. Is the customer's target allocation appropriate and profitable after costs? That needs its own research/evaluation.
2. Does your product repeatedly save the customer enough monitoring, approval, or operations work to justify its price? That is the business question.

Version 2 is usable for the first question's **operations layer** without pretending to solve portfolio research: it records drift observations, emits a machine-readable monitor contract, fingerprints the active policy, fails closed on partial/typoed explicit policies, and keeps managed execution behind a durable single-writer/reconciliation boundary.

## Product ladder

| Product | Customer value | Authority | First useful metric |
|---|---|---|---|
| Drift monitor | “Tell me when treasury moves outside policy” | Read only | First real drift report |
| Policy workspace | Saved targets, history, team/reporting | Read only | Saved policy used again |
| Rebalance copilot | Exact plan + quote + simulation + approval | User approves each action | Successful simulation after a useful plan |
| Managed automation | Policy-bounded recurring rebalances | Managed execution | Reconciled actions with zero duplicates |

Do not jump to the last row merely because the API can execute.

## MVP 1: treasury drift monitor

Start with the current `check` path:

1. customer connects/creates a dedicated managed wallet;
2. customer stores target weights and a drift threshold;
3. service reads the current portfolio on a schedule;
4. service stores a normalized drift snapshot;
5. alert only when policy is breached; and
6. link the alert to the exact holdings/targets that produced it.

The standalone CLI already supplies the local evidence contract:

```bash
bun src/index.ts check --json --record --fail-on-drift
bun src/index.ts history --json --limit 100
```

Exit code `2` means the configured threshold or a policy exception needs attention. The stored snapshot uses a policy fingerprint and one-way wallet reference so a scheduler can correlate evidence without printing the full wallet/API credential pair.

Paid boundaries can include more wallets/policies, tighter monitoring intervals, longer history, webhook/Slack/email delivery, branded reports, or team workspaces.

This MVP creates useful recurring output without execution authority.

## MVP 2: treasury approval workspace

Add the deterministic `rebalance` plan, but stop before managed execution:

```text
current portfolio -> policy breach -> USD plan
                  -> fresh quotes -> simulations -> review screen
                  -> stored approval -> STOP
```

Useful paid features:

- approval roles and separation of duties;
- policy templates per treasury/account;
- comments and decision history;
- quote/simulation evidence attached to the decision;
- exports and audit trails;
- alerts for stale approvals or unresolved portfolio drift.

The approval must bind to concrete economic terms. Model/chat text saying “approved” is not authorization.

## MVP 3: bounded managed automation

Only after customers repeatedly use the earlier workflow:

```text
policy breach
  -> deterministic plan
  -> quote
  -> simulation would_execute=true
  -> wallet policy / application approval
  -> persist intent + idempotency key
  -> managed submit
  -> status reconciliation
  -> final amounts / audit
  -> fetch a fresh portfolio before the next action
```

The last step matters for multi-trade rebalances. A partial batch is not the portfolio you started with.

For production, put intent state in your database and enforce one active economic action per workflow/asset pair. The repository's local JSON journal teaches the state transitions; it is not a distributed lock.

## Choose where portfolio intelligence lives

This repository intentionally uses user-supplied fixed weights. If your value proposition is **portfolio optimization**, do not hide that work inside the execution loop.

[PyPortfolioOpt](https://pyportfolioopt.readthedocs.io/) provides portfolio-optimization methods such as efficient-frontier approaches, Black-Litterman allocation, and hierarchical risk parity. [LEAN](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/portfolio-construction/key-concepts) provides a much broader algorithm framework with portfolio-construction/rebalance concepts and execution reality modeling.

Their cost modeling is also a useful reality check. PyPortfolioOpt exposes a [transaction-cost objective](https://pyportfolioopt.readthedocs.io/en/latest/MeanVariance.html), and LEAN's [position-sizing helpers](https://www.quantconnect.com/docs/v2/writing-algorithms/trading-and-orders/position-sizing) account for lot size and pre-calculated order fees. `MIN_REBALANCE_USD` in this repo is only a dust/churn floor; it is not an optimizer or a replacement for quote/gas/slippage economics.

A good product architecture can therefore be:

```text
research/optimizer -> versioned target policy
                  -> Suwappu rebalancer preview
                  -> approval / managed execution
                  -> reconciled portfolio state
```

Version the policy and its evidence independently of the execution code. That lets you replace an optimizer without rewriting custody controls.

## Measure retained value

### Activation

- time to first real portfolio read;
- percent of users who save a target policy;
- percent who see a meaningful drift report;
- percent who reach a valid simulation when action is actually needed.

### Retention

- policies still monitored after 7/30 days;
- users/teams returning to review another drift event;
- alerts that lead to a review, edit, or acknowledged no-action decision;
- paid workspaces with repeated reporting/approval use.

### Execution quality

- simulation block/warn rate;
- submission -> terminal completion rate;
- outcome-unknown rate;
- reconciliation latency;
- duplicate economic actions (target: zero);
- partial-rebalance recovery time.

### Customer policy outcome

If you report investment performance, keep it rigorous and separate:

```text
portfolio outcome
  = realized gains/losses
  + mark-to-market change
  - venue / gas / bridge costs
  - realized slippage
```

Track drawdown, turnover, and benchmark-relative performance when those metrics are appropriate. Do not label a quote estimate as realized P&L.

## Price from contribution margin

Keep your business ledger separate from the customer's portfolio:

```text
monthly builder contribution margin
  = subscription + usage revenue
  - Suwappu/API costs you absorb
  - model / data-provider costs
  - hosting / database / queue / observability costs
  - notification delivery
  - payment processing
  - variable support, credits, and refunds
```

Measure this per paid workspace or customer. A high-frequency monitor can look successful while losing money if its incremental infrastructure/model costs exceed revenue.

Good paid boundaries are workflow capabilities: number of policies/wallets, monitoring frequency, history, reports, team roles, approvals, webhooks, and managed automation. Avoid pricing or marketing language that promises a target allocation will generate profit.

## Production checklist

Before charging for live automation:

- verify each managed wallet belongs to the authenticated customer/agent;
- validate target weights, supported chains, and tokens at configuration time, and require an explicit target before liquidating an unexpected holding;
- make preview the default and live execution a positive opt-in;
- version/fingerprint the active portfolio policy and fail closed on missing explicit config/policy fields;
- enforce a minimum economical action threshold when appropriate, a local maximum cap, plus server-side wallet policies/approvals;
- require `would_execute=true`, not merely an HTTP-successful simulation;
- persist an idempotency key before submission;
- bound managed REST calls; treat timeout/network/HTTP 408/5xx/malformed-success execution responses as outcome-unknown;
- poll known swaps instead of submitting replacements;
- consume terminal final amounts exactly once;
- refresh the portfolio after a completed action before planning another batch;
- keep a single local writer across resume -> fresh portfolio -> plan -> action -> accounting; use DB uniqueness/locks/leases when graduating to multiple workers;
- back up durable state and make corrupt-state recovery an operator procedure, never “delete the file and retry”;
- expose a kill switch and an operator-visible intent/audit timeline;
- ship dependency audit, code scanning, tests/builds, and container-contract gates with every release;
- keep customer investment outcome and builder revenue/cost in separate ledgers.

The product moat is the workflow users trust and return to—not the existence of a `rebalance()` function. The standalone deployment and incident contract is in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
