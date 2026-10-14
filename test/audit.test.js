import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { READ_KEY, RW_KEY, bearer, buildApp } from './helpers.js';

const silent = { warn() {}, error() {} };

test('AuditClient: buffers, batches, retries, no-op when off', async () => {
  /** @type {any[]} */ const calls = [];
  let fail = 1;
  const c = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, batchSize: 2, logger: silent, sleep: async () => {}, fetch: /** @type {typeof fetch} */ (async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    if (fail-- > 0) return new Response('down', { status: 503 });
    return new Response('{}', { status: 200 });
  }) });
  c.record({ action: 'x.one' });
  c.record({ action: 'x.two' });
  c.record({ action: 'x.three' });
  await c.flush();
  assert.deepEqual([calls.length, c.stats.sent, c.buffer.length], [3, 3, 0]);
  assert.equal(calls[0].events[0].id, calls[1].events[0].id, 'retries resend the same ids');
  assert.equal(new AuditClient({ target: null }).record({ action: 'x' }), false);
});

test('API: every write route records its action; denials too; reads do not', async (t) => {
  const audit = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: silent, fetch: async () => new Response('{}', { status: 200 }) });
  const { app } = await buildApp(undefined, { audit });
  t.after(() => app.close());
  const h = { ...bearer(RW_KEY), 'user-agent': 'test-agent' };
  /** @type {[string, string, object|undefined][]} */
  const writes = [
    ['POST', '/v1/namespaces', { name: 'web', defaultLocale: 'en', locales: [{ locale: 'tr' }] }],
    ['PATCH', '/v1/namespaces/web', { description: 'Website' }],
    ['PUT', '/v1/namespaces/web/locales/de', {}],
    ['DELETE', '/v1/namespaces/web/locales/de', undefined],
    ['PUT', '/v1/namespaces/web/keys/hello', { values: { en: 'Hello {name}' } }],
    ['POST', '/v1/namespaces/web/import', { locale: 'tr', strings: { hello: 'Merhaba {name}' } }],
    ['POST', '/v1/namespaces/web/publish', {}],
    ['POST', '/v1/namespaces/web/rollback', { release: 1 }],
    ['DELETE', '/v1/namespaces/web/keys/hello', undefined],
    ['DELETE', '/v1/namespaces/web', undefined],
  ];
  for (const [method, url, payload] of writes) {
    const res = await app.inject({ method: /** @type {any} */ (method), url, headers: h, ...(payload ? { payload } : {}) });
    assert.ok(res.statusCode < 300, `${method} ${url}: ${res.body}`);
  }
  assert.deepEqual(audit.buffer.map((e) => e.action), [
    'atc-content.namespace.create', 'atc-content.namespace.update', 'atc-content.locale.upsert', 'atc-content.locale.delete',
    'atc-content.key.upsert', 'atc-content.translations.import', 'atc-content.release.publish', 'atc-content.release.rollback',
    'atc-content.key.delete', 'atc-content.namespace.delete',
  ]);
  const [create, , locale, , key, imp, pub, rb] = audit.buffer;
  assert.deepEqual([create.outcome, create.actor, create.target, create.userAgent, create.ip, typeof create.requestId], ['success', { type: 'apikey', id: 'console' }, { type: 'namespace', id: 'web' }, 'test-agent', '127.0.0.1', 'string']);
  assert.deepEqual(create.meta, { defaultLocale: 'en', locales: ['en', 'tr'] });
  assert.deepEqual(locale.meta, { locale: 'de', fallback: null, created: true });
  assert.deepEqual([key.target, key.meta], [{ type: 'key', id: 'web/hello' }, { created: true, locales: ['en'], description: false }]);
  assert.deepEqual(imp.meta, { locale: 'tr', added: 1, updated: 0, unchanged: 0, invalid: 0 });
  assert.deepEqual(pub.meta, { release: 1, keys: 1 });
  assert.deepEqual(rb.meta, { release: 2, rollbackOf: 1, restoreDraft: false });

  const before = audit.buffer.length;
  const denied = await app.inject({ method: 'POST', url: '/v1/namespaces', headers: bearer(READ_KEY), payload: { name: 'x', defaultLocale: 'en' } });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual([audit.buffer.length, audit.buffer.at(-1)?.outcome, audit.buffer.at(-1)?.meta], [before + 1, 'denied', undefined]);
  await app.inject({ url: '/v1/namespaces', headers: bearer(RW_KEY) });
  await app.inject({ method: 'POST', url: '/v1/namespaces', headers: bearer(RW_KEY), payload: { name: 'x', defaultLocale: 'nope-nope' } });
  assert.equal(audit.buffer.length, before + 1, 'reads and failed validations are not audit events');
});
