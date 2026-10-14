# Namespaces and locales

A namespace is one application's set of strings (`web`, `mobile`, `emails`). Each has one **default locale**, the source language every other value is checked against and the last stop of every fallback chain.

## Scenario: a website in English, Turkish and Cypriot Turkish

```bash
ccurl -X POST $CONTENT/v1/namespaces -d '{
  "name": "web",
  "defaultLocale": "en",
  "description": "Public website",
  "locales": [ { "locale": "tr" }, { "locale": "tr-CY", "fallback": "tr" } ]
}'
```

`201`, with `Location: /v1/namespaces/web`:

```json
{
  "namespace": {
    "name": "web",
    "defaultLocale": "en",
    "locales": [
      { "locale": "en", "fallback": null, "chain": ["en"] },
      { "locale": "tr", "fallback": null, "chain": ["tr", "en"] },
      { "locale": "tr-CY", "fallback": "tr", "chain": ["tr-CY", "tr", "en"] }
    ],
    "keys": 0,
    "missing": { "en": 0, "tr": 0, "tr-CY": 0 },
    "mismatched": 0,
    "release": null,
    "unpublishedChanges": true
  }
}
```

`chain` is the lookup order a bundle uses: a key missing in `tr-CY` comes from `tr`, then `en`.

## Adding a locale later, changing a fallback

```bash
ccurl -X PUT $CONTENT/v1/namespaces/web/locales/de -d '{}'                      # 201, created
ccurl -X PUT $CONTENT/v1/namespaces/web/locales/de-AT -d '{"fallback":"de"}'    # 201
ccurl -X PUT $CONTENT/v1/namespaces/web/locales/de-AT -d '{"fallback":null}'    # 200, now de-AT -> en
```

Locale tags are BCP 47 `language[-Script][-REGION]` (`en`, `pt-BR`, `zh-Hant-TW`, `es-419`) and case-insensitive on input: `tr-cy` is stored and returned as `tr-CY`.

## Changing the default locale

```bash
ccurl -X PATCH $CONTENT/v1/namespaces/web -d '{"defaultLocale":"tr"}'
```

The new default must already be a locale of the namespace and loses its own fallback. Values are checked against the new default at the next publish, so keys without a `tr` value then block publishing until filled.

## Pitfalls

- `INVALID_FALLBACK`: the fallback is not configured, points at itself, would make a cycle (`tr -> tr-CY -> tr`), or you gave the default locale a fallback.
- `LOCALE_IN_USE` (409) on delete: it is the default, or another locale falls back to it (`details.dependents` lists them). Repoint those first.
- Deleting a locale deletes its draft values. Published releases keep theirs until a new publish.
- `DELETE /v1/namespaces/web` removes the draft and every release; bundles for `web` return 404 straight away.
