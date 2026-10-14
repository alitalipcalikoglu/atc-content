# Import and export

## Scenario: loading an existing `en.json`

Flat and nested objects are both accepted; nested ones are flattened on `.`.

```bash
ccurl -X POST $CONTENT/v1/namespaces/web/import -d '{
  "locale": "en",
  "strings": {
    "nav": { "home": "Home", "cart": "Cart" },
    "cart.items": "{count} items",
    "Footer": "bad key",
    "count": 3
  }
}'
```

```json
{
  "locale": "en",
  "added": 3,
  "updated": 0,
  "unchanged": 0,
  "invalidCount": 2,
  "invalid": [
    { "key": "count", "reason": "value must be a string or an object of strings" },
    { "key": "Footer", "reason": "key must match [a-z0-9][a-z0-9._-]{0,127}" }
  ]
}
```

Valid entries are applied, invalid ones reported (the first 100; `invalidCount` is the total). Nothing is ever deleted by an import.

## Then the translations

```bash
ccurl -X POST $CONTENT/v1/namespaces/web/import -d '{"locale":"tr","strings":{"nav":{"home":"Ana sayfa"},"cart.items":"ürünler","ghost":"x"}}'
```

`cart.items` is reported with a placeholder reason and `ghost` with `unknown key; import en first`: only the default locale creates keys, other locales fill keys that already have a default value.

## Export

```bash
ccurl "$CONTENT/v1/namespaces/web/export/tr"                              # draft, flat
ccurl "$CONTENT/v1/namespaces/web/export/tr?format=nested"                # draft, nested
ccurl "$CONTENT/v1/namespaces/web/export/tr?source=published"             # latest release
```

```json
{ "namespace": "web", "locale": "tr", "source": "draft", "release": null, "strings": { "nav": { "home": "Ana sayfa" } } }
```

Export returns that locale's own values without fallback, which is what a translator or a file-based workflow wants. Applications use [bundles](bundles.md).

## Pitfalls

- `format=nested` returns `409 NESTED_CONFLICT` when a key is also a prefix of another (`nav` and `nav.home`). Use the flat format for such namespaces.
- One import is one request; `BODY_LIMIT` (1 MiB default) bounds its size.
- The same key both flat (`"a.b"`) and nested (`{"a":{"b":…}}`) in one import: the second is reported as invalid.
