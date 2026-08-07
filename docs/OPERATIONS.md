# Operating Suwappu Portfolio Rebalancer

Portfolio Rebalancer 2.x is a standalone, single-writer treasury drift monitor and controlled managed-execution CLI. Its local deployment contract is designed to fail closed around policy ambiguity, state corruption, concurrent writers, and uncertain financial outcomes.

This is an operations contract, not a security certification, investment-performance claim, accounting system, or portfolio recommendation.

## Supported deployment boundary

Treat one state directory/container volume as one operator-owned deployment. The important local files are:

- `execution-journal.json` — economic intent, idempotency, submission, reconciliation, and accounting acknowledgement;
- `drift-history.json` — bounded read-only portfolio-policy observations; and
- `rebalance-live.lock` — exclusive live-cycle writer guard.

Financial/monitor JSON state is loaded strictly. Missing state can initialize; existing invalid JSON/schema cannot silently turn into an empty ledger. Writes use a restrictive temporary file, file `fsync`, atomic rename, mode `0600`, and best-effort directory `fsync`. The state directory is created with mode `0700` where supported.

The local deployment is intentionally single writer for live execution. `rebalance --execute` holds `rebalance-live.lock` across:

```text
resume/reconcile -> fresh portfolio -> plan -> quote/simulate
                 -> submit/reconcile -> final-amount accounting
```

Locking only the HTTP submission would be insufficient: a second process could fetch and retain a stale plan while the first action completes. The wider lock prevents that local race.

`executions --reconcile` takes the same lock, so status reconciliation cannot race a live writer and overwrite newer journal state.

An abnormal process/container death can leave the lock behind. That is a safety stop, not disposable cache. Stop all schedulers/live writers, inspect the journal without `--reconcile`, use the recorded PID plus your process/container supervisor to prove no process still owns the deployment, and only then remove that one stale lock. With schedulers still disabled, immediately run `executions --reconcile` before permitting another live action. Never delete the execution journal to get past a lock.

## Container persistence

The image runs as the non-root `bun` user. Compose mounts `rebalancer_state` at `/data` and sets `SUWAPPU_REBALANCER_STATE_DIR=/data`. The default command is one read-only `check --record`; live execution is never enabled by the image itself.

`docker compose run --rm rebalancer` removes the container but preserves the named state volume.

Before a live upgrade:

1. stop schedulers/live writers;
2. run `executions --reconcile` and inspect unresolved intents;
3. back up the state volume;
4. deploy the new image and run a read/preview canary;
5. confirm prior journal/history state is visible; and
6. re-enable explicit live invocations only after wallet policies/caps are verified.

Do not recreate the volume while an intent is unresolved. Losing an idempotency key can turn a recovery attempt into a new economic action.

## Policy configuration

The built-in policy is only used when no explicit strategy path is supplied. An explicitly supplied config path must exist. An explicit strategy must define all three fields: `allocations`, `threshold`, and `chain`. Partial explicit policies do not inherit built-in weights.

Each check/live plan computes a deterministic policy fingerprint from normalized target weights, threshold, and chain. The fingerprint is evidence for which policy generated an observation/action; it is not a signature or authorization primitive.

Unexpected holdings are policy exceptions. They block rebalance planning until a target is explicitly assigned, including explicit `0` when liquidation is intended.

`MIN_REBALANCE_USD` can suppress planned legs below a configured notional floor. It is a churn/dust guard, not a transaction-cost model. `MAX_REBALANCE_USD` caps the next live economic action. Invalid values fail closed.

Use server-side managed-wallet policies, approvals, and kill/disable controls as the authoritative money boundary; local environment variables are defense in depth.

## Drift-monitor contract

For schedulers and alerting:

```bash
bun src/index.ts check --json --record --fail-on-drift
```

Stdout is one JSON snapshot. Exit code `2` means either a configured drift threshold was breached or an unconfigured holding created a policy exception. API/validation failures use the normal nonzero error path; do not interpret every nonzero result as “rebalance now.”

Snapshots include total observed USD value, normalized drift, policy fingerprint, and a one-way wallet reference. They omit the API key and full wallet address. `SUWAPPU_REBALANCER_HISTORY_LIMIT` bounds retained local snapshots; historical investment accounting/tax lots are outside this product.

If you run the check on a schedule, alert on stale/missing runs as well as breach results. A silent monitor is not evidence that a portfolio is in policy.

## Managed request contract

Direct REST calls use a 25-second deadline by default. `SUWAPPU_OPERATION_TIMEOUT_MS` accepts `100..30000`; invalid configuration fails instead of disabling the deadline.

`SUWAPPU_API_EVENTS=1` writes metadata-only stderr events with operation, outcome, duration, and optional HTTP status. Events deliberately omit credentials, wallet/quote/swap IDs, policy terms, request/response bodies, and error messages. Add tenant/deployment correlation in your logging layer without turning financial identifiers into metric labels.

The currently published `@suwappu/sdk` used for quote construction predates newer managed helpers, so the managed execute/simulate/status REST boundary remains isolated in `src/suwappu.ts`. Verify the package version you deploy; do not assume core-repository source has already been published.

## Retry matrix

| Operation/result | Rule |
|---|---|
| Portfolio/price read failure | Retry with a bounded policy; do not turn missing data into a plan |
| Quote failure | Fetch a fresh quote; no financial side effect has been requested |
| Simulation failure/block | Stop before submission; investigate/fetch fresh evidence |
| Managed execute known 4xx other than 408 | Known rejection; fix the cause before a new action |
| Managed execute timeout/network/408/5xx | **Outcome unknown**; preserve intent/key and reconcile before replacement |
| Managed execute malformed successful response | **Outcome unknown**; preserve intent/key and reconcile |
| Known `swap_id` | Poll status; do not submit a replacement action |
| Terminal success without final amounts | Keep accounting unresolved and reconcile again |

Never place a generic retry decorator around managed submission.

## Monitoring and SLOs

Set thresholds from the customer promise. At minimum measure:

- scheduled check success/failure/staleness;
- wallets/policies currently outside threshold or in policy-exception state;
- time from first breach to review/acknowledgement/action;
- simulation blocks/warnings;
- submitted, outcome-unknown, reconciled, completed, and failed intent counts;
- oldest unresolved intent age and reconciliation latency;
- duplicate economic actions (target: zero);
- state-file/backup failures and stale-lock incidents;
- operation latency/errors from metadata events; and
- variable API/data/compute/notification cost per paid workspace.

Do not label a drift correction or a quote as customer investment performance. Keep portfolio performance and builder contribution margin in separate ledgers.

## Release gates

Before merge/release, CI must pass:

1. TypeScript typecheck;
2. behavior/regression tests;
3. CLI build and help smoke contract;
4. high/critical dependency audit;
5. Compose validation and non-root stateful image build; and
6. CodeQL analysis.

For a live deployment, additionally canary read/preview mode, verify durable state and backups, inspect unresolved intents/locks, and verify server-side wallet limits and kill controls.

## Incident procedure

If a submission outcome becomes ambiguous:

1. stop new `rebalance --execute` invocations;
2. preserve the volume/state directory and original idempotency keys;
3. keep read/status access available;
4. run `bun src/index.ts executions --reconcile` for known swaps;
5. determine every unresolved intent before creating a replacement action;
6. restore from backup only after proving it is safer/newer than current financial state; and
7. resume with one capped canary after the failure mode is understood.

If the failed process left `rebalance-live.lock`, follow the stale-lock procedure above before step 4: prove the process is gone, remove only the stale lock while schedulers remain disabled, then let reconciliation acquire a fresh lock.

If state is corrupt, do **not** delete it and rerun. Preserve the bad file, compare it with the latest known-good backup and authoritative Suwappu execution/status history, reconstruct state, and only then resume.

If an API key may be exposed, stop new execution and rotate/replace authority through the proper control plane while still reconciling actions that may already have been submitted.

## Multi-tenant graduation

The repository itself is a single-tenant/single-writer operator product. A hosted product should isolate tenant identity, credentials, wallets, policies, database rows, queues, logs, backups, and billing. Move the execution state machine into a transactional database with a unique economic-intent constraint plus locks/leases; reserve reconciliation capacity so analysis traffic cannot starve the calls that determine whether money already moved.

The monetizable surface is policy monitoring, history, reports, approvals, audit, and controlled automation. None of those require claiming that the built-in allocation or a rebalance will make the customer money.
