# Audit events

Set both variables to forward events to the audit service (repository `atc-audit`); leave both empty to keep the service silent:

```
AUDIT_URL=http://10.0.0.5:3005
AUDIT_API_KEY=<the content key from AUDIT_API_KEYS, role write>
```

The key id becomes the event `source` on the audit side. Events are buffered in memory (up to 5 000), flushed every 2 seconds in batches of 200, retried with backoff and idempotent ids, and dropped with a log line when the audit service rejects them. A request is never slowed down or failed by auditing.

## Actions

One event per completed write request, `outcome: "success"` for 2xx, `outcome: "denied"` when the key's role refused it (403). Failed validations and other errors are not audit events.

| Action | Request | `meta` |
|---|---|---|
| `atc-content.namespace.create` | `POST /v1/namespaces` | `defaultLocale`, `locales` |
| `atc-content.namespace.update` | `PATCH /v1/namespaces/:ns` | `patch` |
| `atc-content.namespace.delete` | `DELETE /v1/namespaces/:ns` | |
| `atc-content.locale.upsert` | `PUT /v1/namespaces/:ns/locales/:locale` | `locale`, `fallback`, `created` |
| `atc-content.locale.delete` | `DELETE /v1/namespaces/:ns/locales/:locale` | `locale` |
| `atc-content.key.upsert` | `PUT /v1/namespaces/:ns/keys/:key` | `created`, `locales` (changed), `description` (changed or not) |
| `atc-content.key.delete` | `DELETE /v1/namespaces/:ns/keys/:key` | |
| `atc-content.translations.import` | `POST /v1/namespaces/:ns/import` | `locale`, `added`, `updated`, `unchanged`, `invalid` |
| `atc-content.release.publish` | `POST /v1/namespaces/:ns/publish` | `release`, `keys` |
| `atc-content.release.rollback` | `POST /v1/namespaces/:ns/rollback` | `release`, `rollbackOf`, `restoreDraft` |

Targets are `{ "type": "namespace", "id": "<ns>" }`, or `{ "type": "key", "id": "<ns>/<key>" }` for key events. Translated text itself is never copied into audit events.

## Event shape

```json
{
  "id": "0f1a…",
  "at": "2026-09-17T10:00:00.000Z",
  "action": "atc-content.namespace.create",
  "outcome": "success",
  "actor": { "type": "apikey", "id": "atc-console" },
  "target": { "type": "…", "id": "…" },
  "ip": "203.0.113.7",
  "userAgent": "…",
  "requestId": "…",
  "meta": { "…": "…" }
}
```

`meta` carries the request patch or a summary (counts) where useful; secrets never appear in it. Query the audit service by `source=atc-content`, `actionPrefix=atc-content.` or by target to reconstruct what happened to an entity.
