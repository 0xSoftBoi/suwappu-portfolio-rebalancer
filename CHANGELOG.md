# Changelog

## 2.0.0

- Promote the repository from a rebalancing reference to a standalone treasury drift-monitor/rebalancer contract.
- Add machine-readable/recorded drift snapshots, bounded history, policy fingerprints, and attention exit codes.
- Fail closed on missing explicit config files and incomplete explicit strategy policies.
- Add an optional minimum action notional to reduce dust/churn without pretending it is a fee optimizer.
- Harden state writes with strict schema loading, fsync, atomic replace, and restrictive permissions.
- Hold an exclusive writer lock across the full live rebalance cycle.
- Bound direct REST calls, add metadata-only operation events, and classify managed HTTP 408/malformed success as outcome-unknown.
- Add non-root container deployment with persistent state plus an operations/incident runbook.
- Add CLI build/smoke, dependency-audit, container, and CodeQL release gates.

## 1.0.0

- Preview-first fixed-target planner with explicit managed execution.
- Durable idempotency, simulation, reconciliation, and final-amount accounting.
- Block silent liquidation of unconfigured holdings and refresh the portfolio between live economic actions.
