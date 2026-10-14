# Bundles in an application

`GET /v1/bundles/:ns/:locale` returns the latest release for one locale, already resolved along its fallback chain, as a flat `{ key: string }` map.

## Scenario: a page rendered for a Cypriot Turkish visitor

```bash
curl -si -H "Authorization: Bearer $READ_KEY" $CONTENT/v1/bundles/web/tr-CY
```

```
HTTP/1.1 200 OK
etag: "q3m0hD1Tq8a2L0rj5mYbUu8yW2sGQ4uN"
cache-control: public, max-age=60
content-type: application/json; charset=utf-8

{"namespace":"web","locale":"tr-CY","chain":["tr-CY","tr","en"],"release":5,"publishedAt":"2026-10-14T09:00:00.000Z","strings":{"cart.items":"{count} ürün","nav.cart":"Cart","nav.home":"Ana sayfa"}}
```

`nav.cart` has no Turkish value yet, so it comes from `en`. Keys with no value anywhere along the chain are left out.

## Revalidating

Send the ETag back; nothing changed means `304` with an empty body:

```bash
curl -si -H "Authorization: Bearer $READ_KEY" -H 'If-None-Match: "q3m0hD1Tq8a2L0rj5mYbUu8yW2sGQ4uN"' $CONTENT/v1/bundles/web/tr-CY
# HTTP/1.1 304 Not Modified
```

The ETag changes with every publish (a rollback is a new release, so it changes too), never with draft edits.

## A small server-side client

```js
export class Strings {
  #cache = new Map(); // locale -> { etag, strings, at }

  constructor({ baseUrl, apiKey, namespace, maxAgeMs = 60_000 }) {
    Object.assign(this, { baseUrl, apiKey, namespace, maxAgeMs });
  }

  async get(locale) {
    const hit = this.#cache.get(locale);
    if (hit && Date.now() - hit.at < this.maxAgeMs) return hit.strings;
    const res = await fetch(`${this.baseUrl}/v1/bundles/${this.namespace}/${locale}`, {
      headers: { authorization: `Bearer ${this.apiKey}`, ...(hit ? { 'if-none-match': hit.etag } : {}) },
      signal: AbortSignal.timeout(3_000),
    });
    if (res.status === 304 && hit) { hit.at = Date.now(); return hit.strings; }
    if (!res.ok) { if (hit) return hit.strings; throw new Error(`bundle ${locale}: ${res.status}`); }
    const body = await res.json();
    this.#cache.set(locale, { etag: res.headers.get('etag'), strings: body.strings, at: Date.now() });
    return body.strings;
  }

  static format(template, params) {
    return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => (name in params ? String(params[name]) : m));
  }
}

// const t = await strings.get('tr-CY'); Strings.format(t['cart.items'], { count: 3 })  ->  "3 ürün"
```

Keeping the last good copy on errors means an outage of this service never blanks your pages.

## Public bundles

With `CONTENT_PUBLIC_BUNDLES=true` a browser can load bundles directly, without a key:

```bash
curl -s $CONTENT/v1/bundles/web/en
```

Only bundles become public; every other route still needs a key. A request that does send `Authorization` is still checked (a wrong key is `401`). Anonymous requests are rate limited per IP. Only published strings are exposed, but anything published is readable by anyone who can reach the service.

## Pitfalls

- `404 NOT_PUBLISHED` until the first publish; `404 LOCALE_NOT_FOUND` for a locale the latest release does not have (a locale added after the last publish appears after the next one).
- The locale must be configured: `de-CH` does not silently fall back to `de` unless `de-CH` exists with `fallback: "de"`.
- `Cache-Control: public, max-age=60` lets proxies and browsers reuse a bundle for a minute after a publish.
