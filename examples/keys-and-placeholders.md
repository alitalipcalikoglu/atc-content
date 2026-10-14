# Keys, values and placeholders

Keys match `[a-z0-9][a-z0-9._-]{0,127}` (`cart.items`, `checkout.pay-now`). Each key has an optional description (context for translators) and one value per locale.

## Scenario: a cart badge with a count

```bash
ccurl -X PUT $CONTENT/v1/namespaces/web/keys/cart.items -d '{
  "description": "Badge on the cart icon",
  "values": { "en": "{count} items", "tr": "{count} ürün" }
}'
```

`201` (`200` when the key existed):

```json
{
  "created": true,
  "mismatched": [],
  "key": {
    "key": "cart.items",
    "description": "Badge on the cart icon",
    "placeholders": ["count"],
    "values": { "en": "{count} items", "tr": "{count} ürün" },
    "mismatched": [],
    "updatedBy": { "en": "atc-console", "tr": "atc-console" }
  }
}
```

`values` is merged: send only the locales you change, `null` removes one.

## The placeholder rule

`{name}` placeholders (letters, digits, `_`) in every locale must be exactly the set used by the default locale's value. Order and repetition do not matter.

```bash
ccurl -X PUT $CONTENT/v1/namespaces/web/keys/cart.items -d '{"values":{"tr-CY":"{n} ürün"}}'
```

```json
{ "error": { "code": "PLACEHOLDER_MISMATCH", "message": "placeholders {n} must be {count} as in en" } }
```

A non-default value also needs a default value first (`DEFAULT_REQUIRED`). In one request the default is applied before the others, so `{"values":{"tr":"…","en":"…"}}` for a new key works.

## Changing the source text

Changing the default's placeholders is allowed, because translations can only follow afterwards:

```bash
ccurl -X PUT $CONTENT/v1/namespaces/web/keys/cart.items -d '{"values":{"en":"{count} items in {cart}"}}'
# { "created": false, "mismatched": ["tr"], ... }
```

`tr` is now listed in `mismatched` and the namespace cannot be published until it is fixed or removed.

## Finding work for translators

```bash
ccurl "$CONTENT/v1/namespaces/web/keys?missing=tr-CY&limit=50"    # keys without a tr-CY value
ccurl "$CONTENT/v1/namespaces/web/keys?q=checkout"                 # substring of key or description
```

Pages are ordered by key; pass `nextCursor` back as `cursor`.

## Pitfalls

- Braces that are not a placeholder (`{ }`, `{a b}`) are plain text. ICU plural/select syntax is not interpreted; `{count, plural, …}` is plain text too.
- Removing the default value while other locales still have one is refused; remove those first or delete the key.
- Values longer than `MAX_VALUE_LENGTH` (4096 by default) are rejected with `INVALID_VALUE`.
