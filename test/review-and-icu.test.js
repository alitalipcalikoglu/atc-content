import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContentError } from '../src/domain/errors.js';
import { Placeholders } from '../src/domain/rules.js';
import { RW_KEY, WRITE_KEY, bearer, buildApp } from './helpers.js';

test('ICU: argument names from simple, formatted, plural, select and nested arguments', () => {
  assert.equal(Placeholders.of('{count} ürün'), 'count');
  assert.equal(Placeholders.of('{count, plural, one {# item} other {# items in {cart}}}'), 'cart,count');
  assert.equal(Placeholders.of('{g, select, female {She} male {He} other {They}} liked {n, number} posts on {d, date, short}'), 'd,g,n');
  assert.equal(Placeholders.of('{r, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}'), 'r');
  assert.equal(Placeholders.of('{n, plural, offset:1 =0 {nobody} one {you} other {you and # others}}'), 'n');
  assert.equal(Placeholders.of("It''s '{quoted}' {name} {1} { not"), 'name', 'quotes, numbers and stray braces are text');
  assert.equal(Placeholders.of('{count, plural, one {#} few {#} many {#} other {#}}', 'pl'), 'count', 'Polish has few and many');
});

test('ICU: broken complex arguments are refused with the reason', () => {
  /** @param {string} v @param {string} [l] */
  const err = (v, l) => { try { Placeholders.of(v, l); return null; } catch (e) { assert.ok(e instanceof ContentError); return /** @type {ContentError} */ (e).message; } };
  assert.match(String(err('{n, plural, one {x}}')), /needs an "other" option/);
  assert.match(String(err('{n, plural, few {x} other {y}}', 'en')), /"few" is not a plural category of en/);
  assert.match(String(err('{n, plural, one {x} other {y}')), /missing its closing/);
  assert.match(String(err('{n, plural, one {x} one {y} other {z}}')), /appears twice/);
  assert.match(String(err('{n, currency}')), /unknown argument type "currency"/);
  assert.match(String(err('{n, plural, other {a {b, select, x {y}}}}')), /"other"/, 'nested errors surface');
});

test('API: ICU values are validated per locale and placeholder sets compared', async () => {
  const { app } = await buildApp();
  const h = bearer(RW_KEY);
  await app.inject({ method: 'POST', url: '/v1/namespaces', headers: h, payload: { name: 'shop', defaultLocale: 'en', locales: [{ locale: 'tr' }, { locale: 'pl' }] } });
  const en = await app.inject({ method: 'PUT', url: '/v1/namespaces/shop/keys/cart.items', headers: h, payload: { values: { en: '{count, plural, one {# item} other {# items}}' } } });
  assert.equal(en.statusCode, 201, en.body);
  const bad = await app.inject({ method: 'PUT', url: '/v1/namespaces/shop/keys/cart.items', headers: h, payload: { values: { tr: '{count, plural, few {# ürün} other {# ürün}}' } } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'INVALID_MESSAGE');
  const pl = await app.inject({ method: 'PUT', url: '/v1/namespaces/shop/keys/cart.items', headers: h, payload: { values: { pl: '{count, plural, one {# produkt} few {# produkty} many {# produktów} other {# produktu}}', tr: '{count, plural, other {# ürün}}' } } });
  assert.equal(pl.statusCode, 200, pl.body);
  const mismatch = await app.inject({ method: 'PUT', url: '/v1/namespaces/shop/keys/cart.items', headers: h, payload: { values: { tr: '{n, plural, other {# ürün}}' } } });
  assert.equal(mismatch.json().error.code, 'PLACEHOLDER_MISMATCH');
  await app.close();
});

test('API: review workflow, four eyes, stale reviews, filters, PUBLISH_REQUIRES_REVIEW', async () => {
  const { app } = await buildApp({ PUBLISH_REQUIRES_REVIEW: 'true', ACTOR_KEYS: 'console' });
  const dev = { ...bearer(RW_KEY), 'x-actor': 'dev.ali' };
  const lead = { ...bearer(RW_KEY), 'x-actor': 'lead.ayse' };
  const translator = bearer(WRITE_KEY);
  await app.inject({ method: 'POST', url: '/v1/namespaces', headers: dev, payload: { name: 'web', defaultLocale: 'en', locales: [{ locale: 'tr' }] } });
  await app.inject({ method: 'PUT', url: '/v1/namespaces/web/keys/hello', headers: dev, payload: { values: { en: 'Hello {name}' } } });
  await app.inject({ method: 'PUT', url: '/v1/namespaces/web/keys/hello', headers: translator, payload: { values: { tr: 'Merhaba {name}' } } });
  const blocked = await app.inject({ method: 'POST', url: '/v1/namespaces/web/publish', headers: lead, payload: {} });
  assert.equal(blocked.statusCode, 409);
  assert.deepEqual(blocked.json().error.details.problems.map((/** @type {any} */ p) => `${p.locale}:${p.reason}`), ['en:not approved (pending)', 'tr:not approved (pending)']);
  const pending = (await app.inject({ url: '/v1/namespaces/web/keys?review=pending&reviewLocale=tr', headers: lead })).json().items;
  assert.deepEqual(pending.map((/** @type {any} */ k) => k.key), ['hello']);
  assert.equal(pending[0].review.tr.state, 'pending');
  const self = (await app.inject({ method: 'POST', url: '/v1/namespaces/web/review', headers: dev, payload: { decision: 'approve', items: [{ key: 'hello', locale: 'en' }] } })).json();
  assert.deepEqual([self.updated, self.skipped[0].code], [0, 'SELF_REVIEW']);
  const stale = (await app.inject({ method: 'POST', url: '/v1/namespaces/web/review', headers: lead, payload: { decision: 'approve', items: [{ key: 'hello', locale: 'tr', value: 'Merhaba eski {name}' }] } })).json();
  assert.equal(stale.skipped[0].code, 'CHANGED');
  const ok = (await app.inject({ method: 'POST', url: '/v1/namespaces/web/review', headers: lead, payload: { decision: 'approve', note: 'looks good', items: [{ key: 'hello', locale: 'en' }, { key: 'hello', locale: 'tr', value: 'Merhaba {name}' }, { key: 'nope', locale: 'tr' }] } })).json();
  assert.deepEqual([ok.updated, ok.skipped.map((/** @type {any} */ x) => x.code)], [2, ['NOT_FOUND']]);
  const key = (await app.inject({ url: '/v1/namespaces/web/keys/hello', headers: lead })).json().key;
  assert.deepEqual([key.review.tr.state, key.review.tr.by, key.review.tr.note], ['approved', 'lead.ayse', 'looks good']);
  assert.deepEqual((await app.inject({ url: '/v1/namespaces/web', headers: lead })).json().namespace.review.tr, { pending: 0, approved: 1, rejected: 0 });
  assert.equal((await app.inject({ method: 'POST', url: '/v1/namespaces/web/publish', headers: lead, payload: {} })).statusCode, 201);
  // Any change sends the value back to pending; a rejection blocks publishing too.
  await app.inject({ method: 'PUT', url: '/v1/namespaces/web/keys/hello', headers: translator, payload: { values: { tr: 'Selam {name}' } } });
  assert.equal((await app.inject({ url: '/v1/namespaces/web/keys/hello', headers: lead })).json().key.review.tr.state, 'pending');
  await app.inject({ method: 'POST', url: '/v1/namespaces/web/review', headers: lead, payload: { decision: 'reject', note: 'too casual', items: [{ key: 'hello', locale: 'tr' }] } });
  const again = await app.inject({ method: 'POST', url: '/v1/namespaces/web/publish', headers: lead, payload: {} });
  assert.match(JSON.stringify(again.json().error.details.problems), /not approved \(rejected\)/);
  await app.close();
});

test('API: without PUBLISH_REQUIRES_REVIEW, review is informational', async () => {
  const { app } = await buildApp();
  const h = bearer(RW_KEY);
  await app.inject({ method: 'POST', url: '/v1/namespaces', headers: h, payload: { name: 'web', defaultLocale: 'en' } });
  await app.inject({ method: 'PUT', url: '/v1/namespaces/web/keys/a', headers: h, payload: { values: { en: 'A' } } });
  assert.equal((await app.inject({ method: 'POST', url: '/v1/namespaces/web/publish', headers: h, payload: {} })).statusCode, 201);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/namespaces/web/review', headers: bearer(WRITE_KEY), payload: { decision: 'approve', items: [{ key: 'a', locale: 'en' }] } })).json().updated, 1);
  await app.close();
});
