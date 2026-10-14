# Publishing and rollback

Every edit changes the **draft**. Applications only ever see **releases**: immutable, numbered snapshots of the whole namespace.

## Scenario: ship a translation batch

```bash
ccurl -X POST $CONTENT/v1/namespaces/web/publish -d '{"note":"October copy update"}'
```

`201`:

```json
{ "release": { "number": 4, "note": "October copy update", "rollbackOf": null, "keys": 312, "createdBy": "atc-console", "createdAt": "2026-10-14T09:00:00.000Z" } }
```

Bundles switch to release 4 immediately. `GET /v1/namespaces/web` shows `unpublishedChanges: false` until the next edit.

## What blocks a publish

```json
{
  "error": {
    "code": "UNPUBLISHABLE",
    "message": "2 value(s) must be fixed before publishing",
    "details": { "problems": [
      { "key": "cart.items", "locale": "tr", "reason": "placeholders differ from the default locale" },
      { "key": "promo.banner", "locale": "de", "reason": "no en value" }
    ] }
  }
}
```

Both happen after the default text changes (or the default locale changes). Missing translations do **not** block a publish; the bundle falls back.

## History

```bash
ccurl "$CONTENT/v1/namespaces/web/releases?limit=20"       # newest first, nextBefore for older
ccurl "$CONTENT/v1/namespaces/web/releases/3"              # one release with its full content
```

## Scenario: the new copy broke a layout, go back

```bash
ccurl -X POST $CONTENT/v1/namespaces/web/rollback -d '{"release":3}'
# { "release": { "number": 5, "rollbackOf": 3, "note": "rollback to release 3", ... } }
```

Rollback never rewrites history: it publishes release 3's content as release 5. The draft keeps your newer edits (so `unpublishedChanges` turns true); fix them and publish again. To throw the draft away as well:

```bash
ccurl -X POST $CONTENT/v1/namespaces/web/rollback -d '{"release":3,"restoreDraft":true}'
```

That replaces the draft's locales, keys and values with release 3's. Unpublished edits are lost.

## Pitfalls

- Only the newest `RELEASE_RETENTION` releases (100 by default) are kept per namespace; older ones are deleted on publish and cannot be rolled back to. Numbers are never reused.
- Publishing twice without edits creates two identical releases; check `unpublishedChanges` first if that matters.
