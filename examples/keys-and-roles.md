# API keys and roles

`CONTENT_API_KEYS=id:secret[:role]`, comma separated. Secrets are at least 32 characters and unique (`openssl rand -hex 32`). The id becomes the actor in `createdBy`, `updatedBy` and audit events.

| Role | Can |
|---|---|
| `read` | bundles, export, list and get namespaces/keys/releases, stats, metrics |
| `write` | create/change/delete namespaces, locales and keys, import, publish, rollback |
| `readwrite` (default) | both |

## Scenario: the usual set

```
CONTENT_API_KEYS=atc-console:<64 hex>,web-frontend:<64 hex>:read,translation-sync:<64 hex>:write
```

- `atc-console`: people editing and publishing.
- `web-frontend`: the application's server fetching bundles; cannot change anything.
- `translation-sync`: a CI job importing files from a translation vendor; cannot read bundles or stats.

```bash
curl -s -H "Authorization: Bearer $FRONTEND_KEY" -X POST $CONTENT/v1/namespaces/web/publish
# 403 { "error": { "code": "FORBIDDEN", "message": "this API key has no write access" } }
```

## Pitfalls

- Rotating a key means editing `CONTENT_API_KEYS` and restarting. To rotate without downtime, add the new key under a new id, roll it out, then remove the old one.
- A browser should not hold any key. Use `CONTENT_PUBLIC_BUNDLES=true` or fetch bundles server-side.
