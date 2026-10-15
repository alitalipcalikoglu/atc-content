# Plurals, select and ICU messages

Values are ICU MessageFormat strings. The service stores and serves them as written; your application formats them (for example with `intl-messageformat` in the browser or `Intl.PluralRules` by hand). What the service adds is a check that every locale's message is well formed and uses the same arguments as the default locale.

## Plural per locale

English has `one` and `other`:

```bash
curl -X PUT "$CONTENT/v1/namespaces/shop/keys/cart.items" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{ "values": { "en": "{count, plural, =0 {Your cart is empty} one {# item} other {# items}}" } }'
```

Turkish needs only `other`; Polish has `one`, `few`, `many` and `other`:

```json
{ "values": {
  "tr": "{count, plural, =0 {Sepetiniz boş} other {# ürün}}",
  "pl": "{count, plural, one {# produkt} few {# produkty} many {# produktów} other {# produktu}}"
} }
```

Each value is checked against its own locale's CLDR categories. `few` in an English or Turkish value is a mistake:

```json
{ "error": { "code": "INVALID_MESSAGE", "message": "\"few\" is not a plural category of tr (other, or =N) (at character 21)" } }
```

`=0`, `=1` … exact matches are allowed in every locale. `offset:1` works as in ICU.

## Select and nesting

```json
{ "values": { "en": "{gender, select, female {She added {count, plural, one {# photo} other {# photos}}} male {He added {count, plural, one {# photo} other {# photos}}} other {They added {count, plural, one {# photo} other {# photos}}}}" } }
```

The key's placeholders are `count` and `gender`: every other locale must use exactly these two, at any depth (`PLACEHOLDER_MISMATCH` otherwise).

`{n, number}`, `{d, date, short}`, `{t, time}` are formatted arguments; the style after the second comma is passed through unchecked.

## What `INVALID_MESSAGE` catches

| Value | Reason |
|---|---|
| `{n, plural, one {# item}}` | needs an `other` option |
| `{n, plural, one {x} other {y}` | missing its closing `}` |
| `{n, plural, one {a} one {b} other {c}}` | `one` appears twice |
| `{n, currency}` | unknown argument type |
| `{n, select, a {x} b {y}}` | needs an `other` option |

## Literal braces

`{` that does not start an argument is text: `{ not a placeholder`, `{1}`. To write an argument-looking text literally, quote it ICU style: `'{name}'` renders as `{name}`; `''` is one apostrophe.

## Pitfalls

- The bundle carries the ICU source, not formatted text. A client that only does `{name}` replacement shows `{count, plural, …}` raw; use an ICU formatter for keys with complex arguments.
- Changing the default locale's arguments (adding `{gender, select, …}`) marks every other locale mismatched and blocks publishing until they follow.
