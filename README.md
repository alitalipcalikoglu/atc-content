# atc-content

Translations and content strings for applications: namespaces (`web`, `mobile`), BCP 47 locales with one default locale and fallback chains (`tr-CY -> tr -> en`), `{name}` placeholders checked against the default locale, a draft published as immutable numbered releases with rollback, JSON import/export, and fallback-resolved bundles with a strong `ETag` for applications. HTTP only.

Runtime dependencies: `fastify`, `@fastify/rate-limit`, `@atc-web/atc-service-core`. Storage is SQLite via `node:sqlite` (built into Node 22.13+). The folder is self-contained: copy it to any host with Node 22 and run.

## Run

```bash
cp .env.example .env        # set CONTENT_API_KEYS
npm ci
npm run dev
```

Production with PM2 (reads `./.env` through Node's `--env-file`):

```bash
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Production with Docker (mount the database directory):

```bash
docker build -t atc-content .
docker run -p 3013:3013 -v atc-content-data:/data --env-file .env atc-content
```

Tests and type check:

```bash
npm test
npm run typecheck
```

## Model

- **Namespace**: one application's strings. Name `[a-z][a-z0-9-]{0,63}`, one default locale.
- **Locale**: BCP 47 `language[-Script][-REGION]` (`en`, `tr-CY`, `zh-Hant-TW`, `es-419`), canonicalised on input. Optional `fallback` to another locale of the namespace; every chain ends at the default locale. Cycles and a fallback on the default are rejected.
- **Key**: `[a-z0-9][a-z0-9._-]{0,127}`, optional description, one value per locale.
- **Placeholders**: `{name}` (letters, digits, `_`). A value in any locale other than the default must use exactly the default value's placeholder set (`PLACEHOLDER_MISMATCH`) and needs a default value (`DEFAULT_REQUIRED`). Changing the default's placeholders is allowed; drifted values are reported and block publishing until fixed.
- **Draft and releases**: every edit changes the draft. `publish` snapshots the whole namespace as release N+1 (immutable). `rollback` publishes an earlier release's content as a new release (optionally replacing the draft too). The newest `RELEASE_RETENTION` releases are kept.
- **Bundle**: the latest release for one locale, each key resolved along the locale's chain, as a flat `{ key: string }` map.

## API

All `/v1/*` routes and `/metrics` need `Authorization: Bearer <secret>`; bundles may be public (below). Full contract: [openapi.yaml](openapi.yaml), also served at `GET /openapi.yaml`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready`, `/v1/info` | none | Liveness, readiness (DB ping, cached 10 s), identity and capabilities |
| GET | `/metrics` | read | Prometheus text |
| GET | `/v1/namespaces` | read | Namespaces with locales, chains and counts |
| POST | `/v1/namespaces` | write | Create with default locale and optional locales |
| GET / PATCH / DELETE | `/v1/namespaces/:ns` | read / write / write | One namespace; change description or default locale; delete with every release |
| PUT / DELETE | `/v1/namespaces/:ns/locales/:locale` | write | Add a locale or set its fallback; remove it |
| GET | `/v1/namespaces/:ns/keys` | read | Keys with values; `q`, `missing=<locale>`, `limit`, `cursor` |
| GET / PUT / DELETE | `/v1/namespaces/:ns/keys/:key` | read / write / write | One key; create or merge values (`null` removes); delete |
| POST | `/v1/namespaces/:ns/import` | write | Merge flat or nested JSON into one locale; report added/updated/unchanged/invalid |
| GET | `/v1/namespaces/:ns/export/:locale` | read | One locale's own values; `source=draft\|published`, `format=flat\|nested` |
| POST | `/v1/namespaces/:ns/publish` | write | Draft to release N+1; `409 UNPUBLISHABLE` with the problems while values drifted |
| POST | `/v1/namespaces/:ns/rollback` | write | `{ release, restoreDraft? }`: earlier content as a new release |
| GET | `/v1/namespaces/:ns/releases`, `/v1/namespaces/:ns/releases/:number` | read | Release history; one release with content |
| GET | `/v1/bundles/:ns/:locale` | read, or none when public | Published, fallback-resolved strings; `ETag`, `304`, `Cache-Control: public, max-age=60` |
| GET | `/v1/stats` | read | Totals (namespaces, keys, locales, missing, mismatched, releases, last publish) and one row per namespace |

Errors are `{ "error": { "code", "message", "details"? } }` with stable codes: `NAMESPACE_NOT_FOUND`, `LOCALE_NOT_FOUND`, `KEY_NOT_FOUND`, `RELEASE_NOT_FOUND`, `NOT_PUBLISHED` (404); `INVALID_LOCALE`, `INVALID_FALLBACK`, `INVALID_VALUE`, `DEFAULT_REQUIRED`, `PLACEHOLDER_MISMATCH`, `VALIDATION_FAILED` (400); `NAMESPACE_EXISTS`, `LOCALE_IN_USE`, `NESTED_CONFLICT`, `UNPUBLISHABLE`, `LIMIT_EXCEEDED` (409); `UNAUTHORIZED` (401), `FORBIDDEN` (403), `RATE_LIMITED` (429).

### From an application

```bash
curl -s -H "Authorization: Bearer $READ_KEY" http://localhost:3013/v1/bundles/web/tr-CY
# {"namespace":"web","locale":"tr-CY","chain":["tr-CY","tr","en"],"release":5,"publishedAt":"…","strings":{"cart.items":"{count} ürün","nav.cart":"Cart"}}
```

Keep the `ETag` and send it as `If-None-Match`; an unchanged release answers `304`. A small caching client is in [examples/bundles.md](examples/bundles.md).

`/v1/info` capabilities: `locale-fallback`, `placeholder-check`, `releases`, `bundle-etag`, `import-export`, and `public-bundles` when `CONTENT_PUBLIC_BUNDLES=true`.

## Examples

Scenario walkthroughs for every feature (requests, responses, pitfalls): [examples/README.md](examples/README.md).

## Configuration

All configuration is environment variables; see [.env.example](.env.example) for every variable with comments.

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `3013`, `0.0.0.0` | Listen address |
| `CONTENT_API_KEYS` | required | `id:secret[:role[:ns+ns]]`, comma separated; role `read`, `write` or `readwrite` (default); optional namespace scope; secrets ≥ 32 chars, unique |
| `ACTOR_KEYS` | empty | Key ids (the console) that may name the acting person in an `X-Actor` header; records show that name instead of the key id. Ignored for every other key |
| `CONTENT_PUBLIC_BUNDLES` | `false` | Serve bundles to requests without an `Authorization` header |
| `DB_PATH`, `DB_BACKUP_DIR` | `./data/content.db`, next to the file | SQLite file; pre-migration snapshot directory |
| `BODY_LIMIT` | `1048576` | Request body bytes (bounds one import) |
| `RATE_LIMIT_MAX` | `1200` | Requests per minute per key (per IP for anonymous bundles) |
| `MAX_VALUE_LENGTH` | `4096` | Characters per value |
| `MAX_KEYS_PER_NAMESPACE`, `MAX_LOCALES_PER_NAMESPACE` | `20000`, `50` | Size limits |
| `RELEASE_RETENTION` | `100` | Releases kept per namespace |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` and `traceparent` from a reverse proxy |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | empty | Serve HTTPS directly (both or neither) |
| `WEBHOOK_OUT_URL`, `WEBHOOK_OUT_API_KEY`, `WEBHOOK_OUT_TIMEOUT_MS` | empty, empty, `5000` | Publish events to atc-webhook-out (URL and key both or neither; a `publish` key) |
| `AUDIT_URL`, `AUDIT_API_KEY` | empty | Forward audit events (both or neither) |
| `LOG_LEVEL` | `info` | Pino level |

Invalid configuration stops the process at start with a readable message.

## Security notes

- API keys are compared in constant time over every configured key; roles are enforced per route.
- With public bundles on, only `GET /v1/bundles/*` is reachable without a key, and only published strings are exposed. A request that sends a key is still verified.
- Request bodies are schema-validated and unknown fields rejected. Locales, keys and namespace names are pattern-checked; values are length-capped.
- Values are plain strings. Applications must escape them for their output context (HTML, attributes, SQL) like any other text.
- Audit events never contain translated text, only keys, locales and counts.

## Code layout

```
src/
  index.js               entry point
  application.js         composition root, lifecycle
  config.js              environment parsing and validation
  db.js                  schema migrations
  domain/
    content-service.js   draft rules, publish/rollback, bundles, import/export, stats
    rules.js             Locales (canonical tags, chains), Placeholders, KeyPaths (flatten/nest)
    errors.js            ContentError codes and statuses
  store/                 ContentStore (draft), ReleaseStore (releases)
  http/                  ContentApi routes, ApiKeyAuth, Schemas, Views
test/                    node:test suites
examples/                feature walkthroughs
docs/READINESS.md        operational contract
```

## Out of scope by design

- ICU MessageFormat (plural, select, number/date formatting). Placeholders are simple `{name}` substitutions; `{count, plural, …}` is stored as plain text and not interpreted.
- Rich content (HTML, Markdown, media). Values are plain strings.
- Automatic locale truncation: `de-CH` does not fall back to `de` unless `de-CH` is configured with `fallback: "de"`.
- Per-namespace key scoping, key rotation without restart.
- Draft change history per value. Releases are the history; `updatedBy` shows the last editor per value.
- Machine translation and translator workflow states (review, approval).

## Events

With `WEBHOOK_OUT_URL` set, a publish sends `content.release.published` and a rollback `content.release.rolled_back` (namespace, release number, actor). Subscribers refresh their copy instead of waiting for `max-age`. Best effort; see [examples/events.md](examples/events.md).

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every completed write request is forwarded to the audit service as one event (`success`, or `denied` on 403) with the calling key as actor (or, for an `ACTOR_KEYS` key sending `X-Actor`, that admin as actor and the key in `meta.via`), the namespace or key as target, client IP, user agent and request id. Actions: `atc-content.namespace.create|update|delete`, `atc-content.locale.upsert|delete`, `atc-content.key.upsert|delete`, `atc-content.translations.import`, `atc-content.release.publish|rollback`. Events are buffered and sent in batches; the audit service being down never fails a request. Event shape and `meta` per action: [examples/audit-events.md](examples/audit-events.md).

## Scaling model

**B — single-node stateful.** One process owns one SQLite file (`ecosystem.config.cjs` pins `instances: 1`). The serialized-bundle cache is keyed by release number and always correct; bundle request counters are per process. See [docs/READINESS.md](docs/READINESS.md) for the full contract.

## Observability

Structured request logs with request id and trace context, `/metrics` in Prometheus text (namespaces, keys, locales, missing and mismatched translations, latest release and publish time per namespace, bundle requests), `/v1/stats` for dashboards, and `/ready` that pings the database (cached 10 s). See [docs/READINESS.md](docs/READINESS.md).

Event publishing is observable as `events_publish_enabled`, `events_publish_total{result="published|sent|dropped|failed"}` and `events_publish_pending`.

Audit forwarding is observable too: `audit_forward_enabled`, `audit_forward_events_total{result="recorded|sent|dropped|failed"}` and `audit_forward_pending`. A rising `dropped`, or a `pending` that does not drain, means audit events are being lost or delayed; alert on it.

## Backup / restore

The only state to protect is the SQLite file at `DB_PATH` (default `./data/content.db`, plus its WAL sidecars while running). Take an online copy with `sqlite3 data/content.db "VACUUM INTO 'backup.db'"`. Restore by stopping the service, replacing the file and starting again. Before applying a pending migration to an existing database the service snapshots the file to `DB_PATH.pre-v<N>-<timestamp>-<pid>` (directory overridable with `DB_BACKUP_DIR`). Migrations are not reversible; to roll back, restore the pre-migration copy and run the previous version.

## License

MIT, see [LICENSE](LICENSE).
