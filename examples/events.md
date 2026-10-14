# Events

```bash
WEBHOOK_OUT_URL=http://webhook-out.internal:3009
WEBHOOK_OUT_API_KEY=<a webhook-out key with the publish role>
```

| Event | When | Data |
|---|---|---|
| `content.release.published` | A draft was published as a new release | `namespace`, `release`, `keyCount`, `by` |
| `content.release.rolled_back` | An earlier release was published again | `namespace`, `release` (the new one), `rollbackOf`, `by` |

Subscribe a service or a CDN purge hook in atc-webhook-out to `content.release.*` and refetch the bundle (`GET /v1/bundles/:ns/:locale`, `If-None-Match`) when it fires. Without it, clients see a new release after `max-age=60`.

The event goes out after the release is stored. Best effort (in-memory queue, retries, lost on a restart); keep the normal `max-age` refresh as a safety net.
