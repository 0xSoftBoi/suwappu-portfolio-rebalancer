# Security Policy

This repository is a standalone treasury-monitor/rebalancer built on the
[Suwappu API](https://github.com/0xSoftBoi/suwappubot). Its explicit live mode
can initiate real financial transactions. Treat API keys, wallet metadata,
policy configuration, execution journals, and deployment state as sensitive.

## Reporting a vulnerability

**Do not open a public issue for security reports.** Instead:

- Use **GitHub Private Vulnerability Reporting** when it is enabled for this repository, or
- Email **security@suwappu.bot**.

Please include the affected file, version or commit, reproduction steps, and an
impact assessment.

**Scope note:** issues in this repository's own code, SDK usage, dependencies,
or CI belong here. Vulnerabilities in the Suwappu API, core bot, smart
contracts, custody/key-management layer, or shared SDK should be reported
upstream through the
[core security policy](https://github.com/0xSoftBoi/suwappubot/security/policy).

## Custody and execution model

This repository's `check` and default `rebalance` flows are read/preview only.
The explicit `rebalance --execute` path uses Suwappu's **managed-wallet**
`POST /v1/agent/swap/execute` endpoint; this repository never stores a private
key or signs locally. The configured wallet address must belong to the
authenticated agent.

Live execution requires a passing `would_execute` simulation, persists a
durable idempotency key before submission, and reconciles a known `swap_id`
before another economic action is planned. The CLI also holds a filesystem
lock across resume, fresh portfolio read, planning, submission/reconciliation,
and accounting so a second local writer cannot act on a concurrently stale
plan. Reconciliation takes the same lock so it cannot race a live writer. A
crash can leave that lock as an intentional safety stop: stop schedulers,
inspect state read-only, prove the owning process is gone, clear only the
stale lock, then reconcile before re-enabling live work.

Existing financial/monitor JSON state fails closed on parse/schema errors and
is replaced atomically after file fsync with restrictive permissions. Do not
delete a corrupt journal to make the application start. Restore/reconstruct it
against authoritative execution status first.

Direct REST operations have a bounded deadline. Managed timeout/network/HTTP
408/5xx/malformed-success responses can be outcome-unknown and must be
reconciled rather than blind-retried. Optional API events contain only
operation/outcome/duration/status metadata, never credentials, wallet/quote/
swap identifiers, policy terms, response bodies, or error messages.

Production multi-worker deployments must replace the local store/lock with
transactional intent uniqueness, locking/leases, and an append-only audit log.

Suwappu also supports an unsigned self-custody preparation flow, but this
example does not expose it. Use test/dedicated wallets and conservative
server-side wallet policies before enabling managed execution, and never
commit credentials.

CI gates typecheck, behavior tests, the built CLI, dependency advisories,
container construction, and CodeQL. These controls reduce risk; they are not a
security audit, certification, or guarantee.

## Our commitment

- **Acknowledge** reports within 3 business days.
- **Triage and severity** within 7 business days.
- **Coordinate disclosure** with the reporter and provide credit unless
  anonymity is requested.

## Safe harbor

Good-faith research conducted under this policy, without privacy violations,
data destruction, or service degradation, will not result in legal action from
us. If in doubt, contact us before testing.
