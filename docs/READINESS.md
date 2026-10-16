# `atc-content` readiness contract

## Purpose
`atc-content` holds the translations and content strings of applications. A namespace (`web`,
`mobile`) has BCP 47 locales with one default locale and optional fallback chains
(`tr-CY -> tr -> en`), keys with per-locale values whose `{name}` placeholders must match the
default locale's, and a draft that is published as immutable numbered releases (with rollback).
Applications read published, fallback-resolved bundles with a strong `ETag`.

## Dependencies
- `atc-audit` (`AUDIT_URL` + `AUDIT_API_KEY`): optional, both-or-neither. When unset, the
  `AuditClient.hook` `onSend` hook is a no-op. When set, every successful (or 403-denied) write on a
  route carrying `config.audit` is queued in memory and flushed in the background every 2 s
  (`@atc-web/atc-service-core/audit`); the outbound `POST {AUDIT_URL}/v1/events/batch` never sits on
  the request path. While audit is unreachable, events accumulate in an in-memory buffer
  (`MAX_BUFFER = 5_000`, oldest dropped with a warning) and are lost on an ungraceful exit.
- `atc-webhook-out` (`WEBHOOK_OUT_URL` + `WEBHOOK_OUT_API_KEY`, a publish-role key): optional,
  both-or-neither. `content.release.published` and `content.release.rolled_back` events are published best effort from a bounded in-memory queue (500
  events, three retries, an idempotency key each) in the background; the request path never waits
  on it, and events still queued at a restart are lost (atc-stack `docs/EVENTS.md`).

No other service or external system is called.

## Persistence
SQLite via `node:sqlite` (`src/db.js`, base class from service-core): WAL, `synchronous = NORMAL`,
`busy_timeout = 5000`, foreign keys on. File: `DB_PATH`, default `./data/content.db` (Docker:
`/data/content.db`, `/data` is a volume).

Schema (`Database.MIGRATIONS[0]`):
- `namespaces`: `name` (PK), `default_locale`, `description`, `created_by`, `created_at`,
  `updated_at`, `draft_updated_at`, `draft_version` (bumped on every draft change),
  `published_version` (draft version the latest release holds; NULL when it does not match the draft).
- `locales`: `(ns, locale)` PK, `fallback`, `created_at`; cascades from `namespaces`.
- `keys`: `(ns, key)` PK, `description`, `created_at`, `updated_at`; cascades from `namespaces`.
- `translations`: `(ns, key, locale)` PK, `value`, `placeholders` (sorted, comma-joined),
  `updated_by`, `updated_at`; cascades from `keys` and `locales`; index `(ns, locale)`.
- `releases`: `(ns, number)` PK, `note`, `rollback_of`, `key_count`, `content` (whole namespace as
  JSON), `created_by`, `created_at`; cascades from `namespaces`.

Migrations: ordered SQL blocks, each in `BEGIN IMMEDIATE`/`COMMIT`, tracked by `PRAGMA user_version`
and `schema_migrations`; an existing database is snapshotted with `VACUUM INTO` before the first
pending migration. A database newer than the build refuses to open. No down migrations.

## Health endpoint
`GET /health` returns `{ status: 'ok' }` without I/O. Logged at `warn`.

## Readiness endpoint
`GET /ready` runs `db.ping()` (`SELECT 1`), cached for `ContentApi.READY_CACHE_MS = 10_000` ms; a
failure returns `503 { status: 'unavailable', error }`. Read-only, safe to poll.

## Graceful shutdown
`SIGTERM`/`SIGINT` run, in order: `app.close()` (stop accepting, drain in-flight requests) →
`audit.close()` (final flush) → `db.close()`. A 30 s force-exit timer runs in parallel
(`Lifecycle.install`). PM2 `kill_timeout` is 35 s, above it. `uncaughtException` exits immediately.

## Resource limits
- `BODY_LIMIT` (default 1 MiB): request body cap; bounds one import.
- `MAX_VALUE_LENGTH` (4096 characters per value), `MAX_KEYS_PER_NAMESPACE` (20 000),
  `MAX_LOCALES_PER_NAMESPACE` (50): `LIMIT_EXCEEDED` (409) / `INVALID_VALUE` (400) beyond.
- `RELEASE_RETENTION` (100): releases kept per namespace; older ones are deleted on publish.
- Import reports list at most 100 invalid entries (`invalidCount` has the total).
- Bundle cache: at most 1 000 serialized bundles in memory, reset when full.
- `RATE_LIMIT_MAX` (1 200) requests per minute per key, per IP for anonymous bundle requests.
- PM2 `max_memory_restart: '300M'`.

## Timeouts
- Audit outbound call: 5 s per attempt (service-core default).
- Shutdown force-exit: 30 s. PM2 `listen_timeout`: 10 s.
- No synchronous outbound call in the request path.

## Retry policy
Only audit forwarding retries, on its own timer: up to 6 attempts per batch with exponential
backoff (500 ms doubling, capped at 30 s); 4xx other than 429 drops the batch; exhausted batches
stay buffered for the next flush. Nothing in the request path retries.

## Idempotency
- `POST /v1/namespaces`, `.../import`, `.../publish`, `.../review` and `.../rollback` honour
  `Idempotency-Key` (core `Idempotency`, 24 h, per API key and caller): a repeat replays the first
  2xx answer instead of creating a second release. Without the header a repeated namespace create
  is `409 NAMESPACE_EXISTS` and a repeated publish creates another release.
- `PUT .../locales/:locale` and `PUT .../keys/:key` are idempotent; a repeat that changes nothing
  leaves the draft version untouched (`unpublishedChanges` stays false).
- `POST .../import` is idempotent in result: a repeat reports everything `unchanged`.
- `POST .../publish` and `POST .../rollback` are not: each call creates a new release.
- `DELETE` routes return 404 on repeat.
- Reads (bundles, export, lists, stats) are naturally idempotent.

## Backup
State: the SQLite file at `DB_PATH` plus its `-wal`/`-shm` sidecars while running. Online copy:
`sqlite3 <DB_PATH> "VACUUM INTO '<dest>'"`. No backup job ships in this repository.

## Restore
Stop the service, replace the file (remove stale sidecars), start. Forward migrations apply
automatically. Self-contained: no ordering constraint with other services' data.

## Metrics
`GET /metrics` (read role): `content_namespaces`, `content_keys{namespace}`,
`content_locales{namespace}`, `content_missing_translations{namespace,locale}`,
`content_mismatched_translations{namespace}`, `content_release{namespace}`,
`content_last_publish_timestamp_seconds{namespace}` (all read from the database),
`content_bundle_requests_total{namespace,result}` and `content_process_uptime_seconds`
(process-local, reset on restart).

## Logging
Fastify request logging via service-core `requestOptions`: `reqId` (from `X-Request-Id` or a fresh
UUID), `traceId`/`spanId`, `authorization` redacted. Probes and metrics log at `warn`. 5xx errors
are logged with the error object; error bodies are `{ error: { code, message, details? } }`.

## Tracing
`X-Request-Id` is accepted or generated; `traceparent` is continued when `TRUST_PROXY=true`
(`registerRequestContext`), otherwise a fresh trace starts. No outbound request-path calls to
propagate to.

## Security model
Bearer API keys (`CONTENT_API_KEYS=id:secret[:role]`), compared in constant time over every key.
Roles `read`, `write`, `readwrite` enforced per route. With `CONTENT_PUBLIC_BUNDLES=true`, only
`GET /v1/bundles/:ns/:locale` accepts a request without an `Authorization` header; a presented key
is always verified (wrong key 401, no read role 403). Bodies are schema-validated with unknown
fields rejected; locales are canonicalised with `Intl.getCanonicalLocales` and restricted to
`language[-Script][-REGION]`; key and namespace names are pattern-checked; values are length-capped.
Values are stored and served as plain strings: applications must escape them for their output
context (HTML, SQL, shell) like any other text. Out of scope: per-namespace key scoping, key
rotation without restart, authenticating end users.

## Scaling model
**B — single-node stateful**: one process per SQLite file (`instances: 1`). The bundle cache and
bundle request counters are per process; two processes on one file would serve correct bundles
(cache keys include the release number, read fresh per request) but report diverging counters.

## Single-node / multi-node guarantees
Only the single-process topology is shipped and tested. Every write is one SQLite transaction;
publish reads the draft and writes the release in the same transaction, so a release is always a
consistent snapshot. No distributed coordination exists.

## Known failure modes
- **Disk full**: the write transaction rolls back, the request fails with 500, the draft and
  releases keep their previous state.
- **Audit unreachable**: no effect on requests; events buffer up to 5 000, then oldest are dropped.
- **Killed without shutdown**: buffered audit events are lost; the database stays consistent (WAL).
- **Source text changed**: values in other locales whose placeholders no longer match block
  `publish` (`409 UNPUBLISHABLE` with the list) until fixed; bundles keep serving the last release.
- **Release pruned**: rollback to a release older than `RELEASE_RETENTION` returns 404.
