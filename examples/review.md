# Translator review

Every value has a review state: `pending` (new or changed), `approved` or `rejected`. Reviews are recorded with who, when and an optional note.

## Find what needs review

```bash
curl "$CONTENT/v1/namespaces/web/keys?review=pending&reviewLocale=tr" -H "Authorization: Bearer $KEY"
```

Each key carries its review per locale:

```json
{ "key": "checkout.pay", "values": { "en": "Pay {amount}", "tr": "{amount} öde" },
  "updatedBy": { "en": "dev.ali", "tr": "translator" },
  "review": { "en": { "state": "approved", "by": "lead.ayse", "at": "2026-10-16T08:10:00.000Z", "note": null },
              "tr": { "state": "pending", "by": null, "at": null, "note": null } } }
```

`GET /v1/namespaces/web` has the counts per locale: `"review": { "tr": { "pending": 12, "approved": 230, "rejected": 1 } }`.

## Approve or reject

```bash
curl -X POST "$CONTENT/v1/namespaces/web/review" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "decision": "approve",
  "note": "checked against the style guide",
  "items": [ { "key": "checkout.pay", "locale": "tr", "value": "{amount} öde" }, { "key": "nav.home", "locale": "tr" } ]
}'
```

```json
{ "updated": 1, "skipped": [ { "key": "nav.home", "locale": "tr", "code": "SELF_REVIEW", "reason": "translator wrote this value; someone else must review it" } ] }
```

Skipped items and why:

| Code | Meaning |
|---|---|
| `SELF_REVIEW` | The reviewer is the value's last writer. Through the console the signed-in admin is the actor (`X-Actor`), so two admins can review each other's work with the same console key. |
| `CHANGED` | `value` was sent and the draft value is different now: someone edited it while you were reading. Look again. |
| `NOT_FOUND` | No value for that key and locale. |
| `INVALID_LOCALE` | The locale tag is not valid. |

Rejecting works the same way with `"decision": "reject"`; put the reason in `note`. Any edit afterwards sets the value back to `pending`.

## Require approval before publishing

```
PUBLISH_REQUIRES_REVIEW=true
```

Publishing then fails while any value is not approved:

```json
{ "error": { "code": "UNPUBLISHABLE", "message": "2 value(s) must be fixed before publishing",
  "details": { "problems": [ { "key": "checkout.pay", "locale": "tr", "reason": "not approved (pending)" }, { "key": "nav.home", "locale": "tr", "reason": "not approved (rejected)" } ] } } }
```

Default-locale values need approval too. Without the setting, review states are only information.

## Pitfalls

- Imports and rollbacks with `restoreDraft` create `pending` values; with `PUBLISH_REQUIRES_REVIEW` plan a review round after them.
- A key with a single writer (one API key, no `X-Actor`) can never be self-approved: give reviewers their own key, or review through the console.
