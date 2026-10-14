# Stats and dashboards

`GET /v1/stats` (read role) is the one call an overview page needs.

```bash
ccurl $CONTENT/v1/stats
```

```json
{
  "namespaces": 2,
  "keys": 418,
  "locales": 5,
  "missing": 37,
  "mismatched": 1,
  "releases": 9,
  "lastPublish": { "namespace": "web", "release": 5, "at": "2026-10-14T09:00:00.000Z", "by": "atc-console" },
  "items": [
    {
      "namespace": "web", "defaultLocale": "en", "keys": 312, "locales": 3,
      "missing": 30, "missingByLocale": { "tr": 4, "tr-CY": 26 },
      "mismatched": 1, "release": 5, "publishedAt": "2026-10-14T09:00:00.000Z", "publishedBy": "atc-console",
      "unpublishedChanges": true
    }
  ]
}
```

- `missing`: (key, locale) pairs without a draft value, counting the default locale too. Fallback still serves something for these; the count is translator work, not breakage.
- `mismatched`: draft values that block publishing (placeholders differ from the default, or no default value).
- `unpublishedChanges`: the draft differs from what bundles serve.
- `releases`: releases currently kept, across namespaces.

The same numbers are on `/metrics` for alerting, see [operations](operations.md).
