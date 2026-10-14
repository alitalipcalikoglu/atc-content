# content examples

Scenario-driven walkthroughs of every feature. Requests to `/v1/*` need `Authorization: Bearer <secret>` from `CONTENT_API_KEYS` (bundles can be public, see below). Base URL below is `http://localhost:3013`.

| Example | Shows |
|---|---|
| [Namespaces and locales](namespaces-and-locales.md) | Creating `web` and `mobile`, the default locale, fallback chains like `tr-CY -> tr -> en` |
| [Keys, values and placeholders](keys-and-placeholders.md) | Adding keys, per-locale values, `{name}` placeholder checks, finding missing translations |
| [Import and export](import-export.md) | Loading a locale from flat or nested JSON, the report, exporting draft or published strings |
| [Publishing and rollback](publishing-and-rollback.md) | Draft vs release, what blocks a publish, release history, rolling back |
| [Bundles in an application](bundles.md) | Fetching fallback-resolved strings, ETag and 304, a small client, public bundles |
| [Stats and dashboards](stats.md) | `/v1/stats` for an overview page, what each count means |
| [API keys and roles](keys-and-roles.md) | Read, write, readwrite; which key goes where |
| [Operations](operations.md) | Health, readiness, metrics, environment, PM2, Docker, backups |
| [Events](events.md) | `content.release.published` and `content.release.rolled_back` through atc-webhook-out |
| [Audit events](audit-events.md) | Which write actions are forwarded to the audit service, event shape, configuration |

Set up once for the examples:

```bash
export CONTENT=http://localhost:3013
export KEY=<a readwrite secret from CONTENT_API_KEYS>
alias ccurl='curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json"'
```
