import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { test } from 'node:test';
import { ContentApi } from '../src/http/content-api.js';
import { READ_KEY, RW_KEY, WRITE_KEY, bearer, buildApp } from './helpers.js';

const json = (/** @type {import('light-my-request').Response} */ r) => JSON.parse(r.body);
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** @param {import('fastify').FastifyInstance} app */
async function seed(app) {
  const h = bearer(RW_KEY);
  let res = await app.inject({ method: 'POST', url: '/v1/namespaces', headers: h, payload: { name: 'web', defaultLocale: 'en', locales: [{ locale: 'tr-cy', fallback: 'tr' }, { locale: 'tr' }] } });
  assert.equal(res.statusCode, 201, res.body);
  res = await app.inject({ method: 'POST', url: '/v1/namespaces/web/import', headers: h, payload: { locale: 'en', strings: { nav: { home: 'Home', cart: 'Cart' }, 'cart.items': '{count} items' } } });
  assert.equal(res.statusCode, 200, res.body);
  res = await app.inject({ method: 'POST', url: '/v1/namespaces/web/import', headers: h, payload: { locale: 'tr', strings: { 'nav.home': 'Ana sayfa', 'cart.items': '{count} ürün' } } });
  assert.deepEqual([json(res).added, json(res).invalidCount], [2, 0]);
}

test('API: probes, info, openapi, auth and roles', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/ready' })).statusCode, 200);
  const spec = await app.inject({ url: '/openapi.yaml' });
  assert.equal(spec.body, readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
  const info = json(await app.inject({ url: '/v1/info' }));
  assert.deepEqual([info.service, info.version, info.apiVersion, typeof info.schemaVersion, typeof info.serviceCore], ['atc-content', PACKAGE_VERSION, 'v1', 'number', 'string']);
  assert.deepEqual(info.capabilities, ['locale-fallback', 'placeholder-check', 'releases', 'bundle-etag', 'import-export', 'icu-messages', 'review']);
  assert.equal((await app.inject({ url: '/v1/namespaces' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/namespaces', headers: bearer('x'.repeat(40)) })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/namespaces', headers: bearer(WRITE_KEY) })).statusCode, 403, 'write-only key cannot read');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/namespaces', headers: bearer(READ_KEY), payload: { name: 'web', defaultLocale: 'en' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/namespaces', headers: bearer(WRITE_KEY), payload: { name: 'web', defaultLocale: 'en' } })).statusCode, 201);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/namespaces', headers: bearer(WRITE_KEY), payload: { name: 'web', defaultLocale: 'en' } })).statusCode, 409);
  assert.equal(json(await app.inject({ method: 'POST', url: '/v1/namespaces', headers: bearer(WRITE_KEY), payload: { name: 'x', defaultLocale: 'english' } })).error.code, 'INVALID_LOCALE');
  assert.equal(json(await app.inject({ method: 'POST', url: '/v1/namespaces', headers: bearer(WRITE_KEY), payload: { name: 'x', defaultLocale: 'en', extra: 1 } })).error.code, 'VALIDATION_FAILED');
  assert.equal((await app.inject({ url: '/v1/bundles/web/en' })).statusCode, 401, 'bundles need a key unless public');
  assert.equal((await app.inject({ url: '/metrics', headers: bearer(WRITE_KEY) })).statusCode, 403);
  assert.equal((await app.inject({ url: '/v1/nope', headers: bearer(RW_KEY) })).statusCode, 404);
});

test('API: namespace, locales, keys with placeholder checks', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  await seed(app);
  const h = bearer(RW_KEY);
  let res = await app.inject({ url: '/v1/namespaces/web', headers: bearer(READ_KEY) });
  const ns = json(res).namespace;
  assert.deepEqual(ns.locales.find((/** @type {any} */ l) => l.locale === 'tr-CY'), { locale: 'tr-CY', fallback: 'tr', chain: ['tr-CY', 'tr', 'en'] });
  assert.deepEqual([ns.keys, ns.missing, ns.release, ns.unpublishedChanges], [3, { en: 0, tr: 1, 'tr-CY': 3 }, null, true]);

  res = await app.inject({ method: 'PUT', url: '/v1/namespaces/web/keys/cart.items', headers: h, payload: { values: { 'tr-CY': '{n} ürün' } } });
  assert.deepEqual([res.statusCode, json(res).error.code], [400, 'PLACEHOLDER_MISMATCH']);
  res = await app.inject({ method: 'PUT', url: '/v1/namespaces/web/keys/greeting', headers: h, payload: { description: 'Header greeting', values: { en: 'Hi {name}', 'TR-cy': 'Merhaba {name}' } } });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(json(res).key.values, { en: 'Hi {name}', 'tr-CY': 'Merhaba {name}' });
  assert.deepEqual(json(res).key.placeholders, ['name']);
  res = await app.inject({ method: 'PUT', url: '/v1/namespaces/web/keys/greeting', headers: h, payload: { values: { en: 'Hi {first}' } } });
  assert.deepEqual([res.statusCode, json(res).mismatched, json(res).key.mismatched], [200, ['tr-CY'], ['tr-CY']]);
  assert.equal(json(await app.inject({ method: 'PUT', url: '/v1/namespaces/web/keys/Greeting', headers: h, payload: {} })).error.code, 'VALIDATION_FAILED');

  res = await app.inject({ url: '/v1/namespaces/web/keys?missing=tr&limit=1', headers: h });
  assert.deepEqual(json(res).items.map((/** @type {any} */ k) => k.key), ['greeting']);
  assert.equal(json(res).nextCursor, 'greeting');
  res = await app.inject({ url: `/v1/namespaces/web/keys?missing=tr&limit=1&cursor=${json(res).nextCursor}`, headers: h });
  assert.deepEqual([json(res).items.map((/** @type {any} */ k) => k.key), json(res).nextCursor], [['nav.cart'], null]);
  assert.deepEqual(json(await app.inject({ url: '/v1/namespaces/web/keys?q=nav', headers: h })).items.map((/** @type {any} */ k) => k.key), ['nav.cart', 'nav.home']);
  assert.equal(json(await app.inject({ url: '/v1/namespaces/web/keys?missing=de', headers: h })).error.code, 'LOCALE_NOT_FOUND');

  res = await app.inject({ method: 'PUT', url: '/v1/namespaces/web/locales/tr', headers: h, payload: { fallback: 'tr-CY' } });
  assert.deepEqual([res.statusCode, json(res).error.code], [400, 'INVALID_FALLBACK']);
  res = await app.inject({ method: 'PUT', url: '/v1/namespaces/web/locales/de', headers: h, payload: {} });
  assert.deepEqual([res.statusCode, json(res).created, json(res).locale], [201, true, 'de']);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/namespaces/web/locales/tr', headers: h })).statusCode, 409);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/namespaces/web/locales/de', headers: h })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/namespaces/web/keys/nav.cart', headers: h })).statusCode, 204);
  assert.equal((await app.inject({ url: '/v1/namespaces/web/keys/nav.cart', headers: h })).statusCode, 404);
  res = await app.inject({ method: 'PATCH', url: '/v1/namespaces/web', headers: h, payload: { description: 'Website' } });
  assert.equal(json(res).namespace.description, 'Website');
  assert.equal(json(await app.inject({ method: 'PATCH', url: '/v1/namespaces/web', headers: h, payload: { defaultLocale: 'fr' } })).error.code, 'LOCALE_NOT_FOUND');
});

test('API: publish, bundles with fallback, ETag/304, rollback, releases', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  await seed(app);
  const h = bearer(RW_KEY);
  assert.equal(json(await app.inject({ url: '/v1/bundles/web/en', headers: bearer(READ_KEY) })).error.code, 'NOT_PUBLISHED');
  let res = await app.inject({ method: 'POST', url: '/v1/namespaces/web/publish', headers: h, payload: { note: 'launch' } });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(json(res).release, { number: 1, note: 'launch', rollbackOf: null, keys: 3, createdBy: 'console', createdAt: json(res).release.createdAt });

  res = await app.inject({ url: '/v1/bundles/web/tr-cy', headers: bearer(READ_KEY) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'public, max-age=60');
  assert.match(String(res.headers['content-type']), /^application\/json/);
  const etag = String(res.headers.etag);
  assert.match(etag, /^"[^"]+"$/, 'strong ETag');
  assert.deepEqual(json(res), { namespace: 'web', locale: 'tr-CY', chain: ['tr-CY', 'tr', 'en'], release: 1, publishedAt: json(res).publishedAt, strings: { 'cart.items': '{count} ürün', 'nav.cart': 'Cart', 'nav.home': 'Ana sayfa' } });
  for (const inm of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
    res = await app.inject({ url: '/v1/bundles/web/tr-CY', headers: { ...bearer(READ_KEY), 'if-none-match': inm } });
    assert.equal(res.statusCode, 304, inm);
    assert.equal(res.body, '');
    assert.equal(res.headers.etag, etag);
  }
  assert.equal((await app.inject({ url: '/v1/bundles/web/tr-CY', headers: { ...bearer(READ_KEY), 'if-none-match': '"stale"' } })).statusCode, 200);
  assert.equal(json(await app.inject({ url: '/v1/bundles/web/de', headers: bearer(READ_KEY) })).error.code, 'LOCALE_NOT_FOUND');
  assert.equal(json(await app.inject({ url: '/v1/bundles/web/klingon-x', headers: bearer(READ_KEY) })).error.code, 'INVALID_LOCALE');
  assert.equal(json(await app.inject({ url: '/v1/bundles/app/en', headers: bearer(READ_KEY) })).error.code, 'NAMESPACE_NOT_FOUND');

  await app.inject({ method: 'PUT', url: '/v1/namespaces/web/keys/nav.home', headers: h, payload: { values: { tr: 'Anasayfa' } } });
  assert.equal((await app.inject({ url: '/v1/bundles/web/tr-CY', headers: { ...bearer(READ_KEY), 'if-none-match': etag } })).statusCode, 304, 'draft edits are not live');
  await app.inject({ method: 'POST', url: '/v1/namespaces/web/publish', headers: h, payload: {} });
  res = await app.inject({ url: '/v1/bundles/web/tr-CY', headers: { ...bearer(READ_KEY), 'if-none-match': etag } });
  assert.equal(res.statusCode, 200, 'new release, new ETag');
  assert.equal(json(res).strings['nav.home'], 'Anasayfa');

  await app.inject({ method: 'PUT', url: '/v1/namespaces/web/keys/cart.items', headers: h, payload: { values: { en: '{n} items' } } });
  res = await app.inject({ method: 'POST', url: '/v1/namespaces/web/publish', headers: h, payload: {} });
  assert.deepEqual([res.statusCode, json(res).error.code, json(res).error.details.problems[0].key], [409, 'UNPUBLISHABLE', 'cart.items']);

  res = await app.inject({ method: 'POST', url: '/v1/namespaces/web/rollback', headers: h, payload: { release: 1 } });
  assert.deepEqual([res.statusCode, json(res).release.number, json(res).release.rollbackOf], [201, 3, 1]);
  res = await app.inject({ url: '/v1/bundles/web/tr-CY', headers: { ...bearer(READ_KEY), 'if-none-match': etag } });
  assert.deepEqual([res.statusCode, json(res).release, json(res).strings['nav.home']], [200, 3, 'Ana sayfa'], 'release 1 content again, as release 3 with its own ETag');
  assert.equal(json(await app.inject({ method: 'POST', url: '/v1/namespaces/web/rollback', headers: h, payload: { release: 99 } })).error.code, 'RELEASE_NOT_FOUND');

  res = await app.inject({ url: '/v1/namespaces/web/releases?limit=2', headers: bearer(READ_KEY) });
  assert.deepEqual([json(res).items.map((/** @type {any} */ r) => r.number), json(res).nextBefore], [[3, 2], '2']);
  res = await app.inject({ url: '/v1/namespaces/web/releases?before=2', headers: bearer(READ_KEY) });
  assert.deepEqual(json(res).items.map((/** @type {any} */ r) => r.number), [1]);
  res = await app.inject({ url: '/v1/namespaces/web/releases/2', headers: bearer(READ_KEY) });
  assert.equal(json(res).release.content.keys['nav.home'].values.tr, 'Anasayfa');
  assert.equal((await app.inject({ url: '/v1/namespaces/web/releases/9', headers: bearer(READ_KEY) })).statusCode, 404);

  res = await app.inject({ url: '/v1/stats', headers: bearer(READ_KEY) });
  assert.deepEqual([json(res).namespaces, json(res).keys, json(res).lastPublish.release, json(res).items[0].unpublishedChanges, json(res).mismatched], [1, 3, 3, true, 1]);
  res = await app.inject({ url: '/metrics', headers: bearer(READ_KEY) });
  assert.match(res.body, /^content_keys\{namespace="web"\} 3$/m);
  assert.match(res.body, /^content_missing_translations\{namespace="web",locale="tr-CY"\} 3$/m);
  assert.match(res.body, /^content_release\{namespace="web"\} 3$/m);
  assert.match(res.body, /^content_bundle_requests_total\{namespace="web",result="not_modified"\} 5$/m);

  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/namespaces/web', headers: h })).statusCode, 204);
  assert.equal((await app.inject({ url: '/v1/bundles/web/en', headers: bearer(READ_KEY) })).statusCode, 404);
});

test('API: public bundles skip the key only when no Authorization header is sent', async (t) => {
  const { app } = await buildApp({ CONTENT_PUBLIC_BUNDLES: 'true' });
  t.after(() => app.close());
  await seed(app);
  await app.inject({ method: 'POST', url: '/v1/namespaces/web/publish', headers: bearer(RW_KEY), payload: {} });
  assert.ok(json(await app.inject({ url: '/v1/info' })).capabilities.includes('public-bundles'));
  const res = await app.inject({ url: '/v1/bundles/web/tr' });
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).strings['nav.home'], 'Ana sayfa');
  assert.equal((await app.inject({ url: '/v1/bundles/web/tr', headers: bearer('x'.repeat(40)) })).statusCode, 401, 'a wrong key is still rejected');
  assert.equal((await app.inject({ url: '/v1/bundles/web/tr', headers: bearer(WRITE_KEY) })).statusCode, 403, 'a key without read is still rejected');
  assert.equal((await app.inject({ url: '/v1/namespaces' })).statusCode, 401, 'only bundles are public');
});

test('API: import and export over HTTP', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  await seed(app);
  const h = bearer(RW_KEY);
  let res = await app.inject({ method: 'POST', url: '/v1/namespaces/web/import', headers: h, payload: { locale: 'tr', strings: { nav: { cart: 'Sepet', home: 'Ana sayfa' }, 'cart.items': 'ürünler', ghost: 'x', n: 1 } } });
  assert.deepEqual([json(res).added, json(res).updated, json(res).unchanged, json(res).invalidCount], [1, 0, 1, 3]);
  res = await app.inject({ url: '/v1/namespaces/web/export/tr?format=nested', headers: bearer(READ_KEY) });
  assert.deepEqual(json(res), { namespace: 'web', locale: 'tr', source: 'draft', release: null, strings: { cart: { items: '{count} ürün' }, nav: { cart: 'Sepet', home: 'Ana sayfa' } } });
  assert.equal(json(await app.inject({ url: '/v1/namespaces/web/export/tr?source=published', headers: bearer(READ_KEY) })).error.code, 'NOT_PUBLISHED');
  assert.equal(json(await app.inject({ method: 'POST', url: '/v1/namespaces/web/import', headers: h, payload: { locale: 'tr', strings: [] } })).error.code, 'VALIDATION_FAILED');
});

test('ContentApi.matches: If-None-Match parsing', () => {
  assert.equal(ContentApi.matches(undefined, '"a"'), false);
  assert.equal(ContentApi.matches('"a"', '"a"'), true);
  assert.equal(ContentApi.matches('W/"a"', '"a"'), true);
  assert.equal(ContentApi.matches('"b", "a"', '"a"'), true);
  assert.equal(ContentApi.matches('"b"', '"a"'), false);
});

test('API: rate limit per key', async (t) => {
  const { app } = await buildApp({ RATE_LIMIT_MAX: '2' });
  t.after(() => app.close());
  await app.inject({ url: '/v1/namespaces', headers: bearer(READ_KEY) });
  await app.inject({ url: '/v1/namespaces', headers: bearer(READ_KEY) });
  const limited = await app.inject({ url: '/v1/namespaces', headers: bearer(READ_KEY) });
  assert.deepEqual([limited.statusCode, json(limited).error.code], [429, 'RATE_LIMITED']);
  assert.equal((await app.inject({ url: '/v1/namespaces', headers: bearer(RW_KEY) })).statusCode, 200);
});

test('API: X-Actor names the acting person only for ACTOR_KEYS keys', async (t) => {
  const audit = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: { warn() {}, error() {} }, fetch: async () => new Response('{}', { status: 200 }) });
  const { app } = await buildApp({ ACTOR_KEYS: 'console' }, { audit });
  t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/v1/namespaces', headers: { ...bearer(RW_KEY), 'x-actor': 'ayse.k' }, payload: { name: 'web', defaultLocale: 'en' } });
  assert.equal(json(res).namespace.createdBy, 'ayse.k');
  const other = await app.inject({ method: 'POST', url: '/v1/namespaces', headers: { ...bearer(WRITE_KEY), 'x-actor': 'ayse.k' }, payload: { name: 'app', defaultLocale: 'en' } });
  assert.equal(json(other).namespace.createdBy, 'translator', 'untrusted keys cannot name someone else');
  const [named, plain] = audit.buffer;
  assert.deepEqual([named.actor, /** @type {any} */ (named.meta)?.via], [{ type: 'admin', id: 'ayse.k' }, 'console'], 'audit names the admin, the key stays in meta.via');
  assert.deepEqual([plain.actor?.type, /** @type {any} */ (plain.meta)?.via], ['apikey', undefined]);
  const bad = await app.inject({ method: 'POST', url: '/v1/namespaces', headers: { ...bearer(RW_KEY), 'x-actor': 'no spaces allowed' }, payload: { name: 'm', defaultLocale: 'en' } });
  assert.equal(json(bad).namespace.createdBy, 'console', 'malformed header falls back to the key id');
  await assert.rejects(buildApp({ ACTOR_KEYS: 'ghost' }), /ACTOR_KEYS names "ghost"/);
});

test('namespace scopes: a scoped key reaches only its namespaces; listings are filtered; totals and other namespaces are refused', async (t) => {
  const SCOPED = 's'.repeat(40);
  const { app } = await buildApp({ CONTENT_API_KEYS: `console:${RW_KEY},site:${SCOPED}:read:web,editor:${WRITE_KEY}:write:web+shop` });
  t.after(() => app.close());
  await seed(app);
  const mk = (/** @type {string} */ name) => app.inject({ method: 'POST', url: '/v1/namespaces', headers: bearer(RW_KEY), payload: { name, defaultLocale: 'en', locales: [] } });
  await mk('other');
  await app.inject({ method: 'POST', url: '/v1/namespaces/web/publish', headers: bearer(RW_KEY), payload: {} });
  assert.equal((await app.inject({ url: '/v1/bundles/web/en', headers: bearer(SCOPED) })).statusCode, 200);
  const denied = await app.inject({ url: '/v1/bundles/other/en', headers: bearer(SCOPED) });
  assert.deepEqual([denied.statusCode, json(denied).error.code], [403, 'FORBIDDEN']);
  assert.deepEqual(json(await app.inject({ url: '/v1/namespaces', headers: bearer(SCOPED) })).items.map((/** @type {any} */ n) => n.name), ['web']);
  assert.equal((await app.inject({ url: '/v1/stats', headers: bearer(SCOPED) })).statusCode, 403);
  assert.equal((await app.inject({ url: '/v1/stats', headers: bearer(RW_KEY) })).statusCode, 200, 'an unscoped key sees everything');
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/namespaces/other/keys/x', headers: bearer(WRITE_KEY), payload: { values: { en: 'x' } } })).statusCode, 403, 'a scoped writer cannot write elsewhere');
  assert.equal((await mkAs(app, WRITE_KEY, 'shop')).statusCode, 201, 'but may create a namespace inside its scope');
  assert.equal((await mkAs(app, WRITE_KEY, 'forbidden')).statusCode, 403);
});

/** @param {import('fastify').FastifyInstance} app @param {string} key @param {string} name */
const mkAs = (app, key, name) => app.inject({ method: 'POST', url: '/v1/namespaces', headers: bearer(key), payload: { name, defaultLocale: 'en', locales: [] } });
