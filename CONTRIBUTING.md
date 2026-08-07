# Contributing

Thanks for improving Suwappu Portfolio Rebalancer. Changes that touch financial intent are held to a stricter standard than presentation-only changes.

## Local verification

Use Bun 1.3.14 or newer:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun audit --audit-level=high
```

Keep preview/read paths usable without granting execution authority. Never put real credentials, wallet secrets, production state, or transaction data in tests/fixtures.

## Money-path invariants

A pull request that can affect live execution should show tests/evidence that:

- explicit config/policy ambiguity fails closed;
- unconfigured holdings cannot be liquidated implicitly;
- the full local live cycle remains single-writer;
- simulation requires `would_execute=true`;
- intent and the idempotency key are durable before managed submission;
- timeout/network/HTTP 408/5xx/malformed-success submission outcomes remain outcome-unknown;
- a known `swap_id` is reconciled instead of replaced;
- accounting consumes terminal final amounts exactly once; and
- the portfolio is fetched again before another economic action is planned.

Do not add generic automatic retries around managed submission.

## Product and docs

Keep customer investment outcome separate from builder revenue/contribution margin. Examples, target weights, quotes, simulations, and backtests must not be marketed as guaranteed returns.

When changing operator behavior, update `README.md`, `docs/OPERATIONS.md`, `.env.example`, and `CHANGELOG.md` as applicable. CI must remain green across tests/build, dependency audit, container contract, and CodeQL.
