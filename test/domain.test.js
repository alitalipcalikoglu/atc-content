import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContentError } from '../src/domain/errors.js';
import { KeyPaths, Locales, Placeholders } from '../src/domain/rules.js';
import { testService, tickingClock } from './helpers.js';

/** @param {string} code */
const fails = (code) => (/** @type {unknown} */ e) => e instanceof ContentError && e.code === code;

/** Namespace `web`: en (default), tr, tr-CY -> tr. @param {Record<string, string>} [overrides] @param {any} [publisher] */
function seeded(overrides = {}, publisher = undefined) {
  const t = testService(overrides, tickingClock(), publisher);
  t.service.createNamespace({ name: 'web', defaultLocale: 'en', locales: [{ locale: 'tr-cy', fallback: 'tr' }, { locale: 'tr' }] }, 'console');
  return t;
}

test('rules: locale canonicalisation, chains, placeholders, key paths', () => {
  assert.equal(Locales.canonical('tr-cy'), 'tr-CY');
  assert.equal(Locales.canonical('zh-hant-tw'), 'zh-Hant-TW');
  assert.equal(Locales.canonical('es-419'), 'es-419');
  for (const bad of ['', 'english', 'en_US', 'en-US-u-ca-buddhist', 'x']) assert.throws(() => Locales.canonical(bad), fails('INVALID_LOCALE'), bad);
  const fb = new Map([['tr-CY', 'tr'], ['tr', null], ['en', null]]);
  assert.deepEqual(Locales.chain('tr-CY', fb, 'en'), ['tr-CY', 'tr', 'en']);
  assert.deepEqual(Locales.chain('en', fb, 'en'), ['en']);
  assert.equal(Placeholders.of('Hi {name}, {count} new, {name} again, {not a placeholder} {}'), 'count,name');
  assert.equal(Placeholders.of('plain'), '');
  assert.deepEqual(KeyPaths.flatten({ a: { b: 'x', c: { d: 'y' } }, 'e.f': 'z', g: 1 }), { entries: [['a.b', 'x'], ['a.c.d', 'y'], ['e.f', 'z']], invalid: [{ key: 'g', reason: 'value must be a string or an object of strings' }] });
  assert.deepEqual(JSON.parse(JSON.stringify(KeyPaths.nest({ 'a.b': 'x', 'a.c': 'y', d: 'z' }))), { a: { b: 'x', c: 'y' }, d: 'z' });
  assert.throws(() => KeyPaths.nest({ a: 'x', 'a.b': 'y' }), fails('NESTED_CONFLICT'));
  assert.ok(KeyPaths.valid('checkout.pay-now_1') && !KeyPaths.valid('Checkout') && !KeyPaths.valid('.a') && !KeyPaths.valid('a'.repeat(129)));
});

test('namespaces and locales: default, fallback validation, cycles, deletion guards', () => {
  const { service } = seeded();
  assert.throws(() => service.createNamespace({ name: 'web', defaultLocale: 'en' }, 'x'), fails('NAMESPACE_EXISTS'));
  assert.throws(() => service.createNamespace({ name: 'Web', defaultLocale: 'en' }, 'x'), fails('INVALID_VALUE'));
  assert.deepEqual(service.content.locales('web').map((l) => [l.locale, l.fallback]), [['en', null], ['tr', null], ['tr-CY', 'tr']]);
  assert.throws(() => service.setLocale('web', 'en', { fallback: 'tr' }), fails('INVALID_FALLBACK'), 'default has no fallback');
  assert.throws(() => service.setLocale('web', 'tr', { fallback: 'tr-CY' }), fails('INVALID_FALLBACK'), 'cycle');
  assert.throws(() => service.setLocale('web', 'tr', { fallback: 'tr' }), fails('INVALID_FALLBACK'), 'self');
  assert.throws(() => service.setLocale('web', 'de', { fallback: 'fr' }), fails('INVALID_FALLBACK'), 'unknown fallback');
  assert.deepEqual(service.setLocale('web', 'de-AT', {}), { created: true, locale: 'de-AT' });
  assert.deepEqual(service.setLocale('web', 'de-at', { fallback: 'en' }), { created: false, locale: 'de-AT' });
  assert.throws(() => service.deleteLocale('web', 'en'), fails('LOCALE_IN_USE'));
  assert.throws(() => service.deleteLocale('web', 'tr'), (e) => fails('LOCALE_IN_USE')(e) && /tr-CY/.test(/** @type {Error} */ (e).message));
  service.deleteLocale('web', 'de-AT');
  assert.throws(() => service.deleteLocale('web', 'de-AT'), fails('LOCALE_NOT_FOUND'));
  const limited = testService({ MAX_LOCALES_PER_NAMESPACE: '2' });
  assert.throws(() => limited.service.createNamespace({ name: 'm', defaultLocale: 'en', locales: [{ locale: 'tr' }, { locale: 'de' }] }, 'x'), fails('LIMIT_EXCEEDED'));
  assert.equal(limited.service.content.namespace('m'), undefined, 'failed create leaves nothing behind');
  service.updateNamespace('web', { defaultLocale: 'tr-CY' }, 'x');
  assert.equal(service.content.locales('web').find((l) => l.locale === 'tr-CY')?.fallback, null, 'new default loses its fallback');
});

test('values: placeholders must match the default, default first, removal order', () => {
  const { service, content } = seeded();
  assert.deepEqual(service.upsertKey('web', 'cart.items', { description: 'Cart badge', values: { tr: '{count} ürün', en: '{count} items' } }, 'console'), { created: true, mismatched: [] }, 'default is applied first in one request');
  assert.throws(() => service.upsertKey('web', 'cart.items', { values: { 'tr-CY': '{n} ürün' } }, 'x'), fails('PLACEHOLDER_MISMATCH'));
  assert.throws(() => service.upsertKey('web', 'cart.items', { values: { 'tr-CY': 'ürünler' } }, 'x'), (e) => fails('PLACEHOLDER_MISMATCH')(e) && /placeholders none must be \{count\}/.test(/** @type {Error} */ (e).message));
  assert.throws(() => service.upsertKey('web', 'other', { values: { tr: 'x' } }, 'x'), fails('DEFAULT_REQUIRED'));
  assert.equal(content.key('web', 'other'), undefined, 'rejected write rolls back the new key');
  assert.throws(() => service.upsertKey('web', 'cart.items', { values: { de: 'x' } }, 'x'), fails('LOCALE_NOT_FOUND'));
  assert.throws(() => service.upsertKey('web', 'cart.items', { values: { en: 'x'.repeat(5000) } }, 'x'), fails('INVALID_VALUE'));
  assert.throws(() => service.upsertKey('web', 'Bad Key', {}, 'x'), fails('INVALID_VALUE'));
  assert.throws(() => service.upsertKey('web', 'cart.items', { values: { en: null } }, 'x'), fails('DEFAULT_REQUIRED'), 'default cannot go while others exist');
  // Changing the default's placeholders is allowed; the drifted locales are reported.
  assert.deepEqual(service.upsertKey('web', 'cart.items', { values: { en: '{count} items for {name}' } }, 'x'), { created: false, mismatched: ['tr'] });
  assert.equal(content.mismatched('web').length, 1);
  service.upsertKey('web', 'cart.items', { values: { tr: null } }, 'x');
  service.upsertKey('web', 'cart.items', { values: { en: null } }, 'x');
  assert.equal(content.translationsOfKey('web', 'cart.items').length, 0);
  assert.equal(service.upsertKey('web', 'cart.items', { description: 'kept' }, 'x').created, false);
  service.deleteKey('web', 'cart.items');
  assert.throws(() => service.key('web', 'cart.items'), fails('KEY_NOT_FOUND'));
  const small = testService({ MAX_KEYS_PER_NAMESPACE: '1' });
  small.service.createNamespace({ name: 'm', defaultLocale: 'en' }, 'x');
  small.service.upsertKey('m', 'a', {}, 'x');
  assert.throws(() => small.service.upsertKey('m', 'b', {}, 'x'), fails('LIMIT_EXCEEDED'));
});

test('publish: snapshot, immutability, refusal on drift, fallback-resolved bundle', () => {
  const { service } = seeded();
  assert.throws(() => service.bundle('web', 'en'), fails('NOT_PUBLISHED'));
  service.upsertKey('web', 'hello', { values: { en: 'Hello {name}', tr: 'Merhaba {name}' } }, 'x');
  service.upsertKey('web', 'bye', { values: { en: 'Bye' } }, 'x');
  service.upsertKey('web', 'local', { values: { en: 'Island', tr: 'Ada', 'tr-CY': 'Kıbrıs' } }, 'x');
  service.upsertKey('web', 'empty', {}, 'x');
  assert.equal(service.summary(service.namespace('web')).unpublishedChanges, true);
  const r1 = service.publish('web', { note: 'first' }, 'console');
  assert.deepEqual([r1.number, r1.key_count, r1.note, r1.created_by], [1, 4, 'first', 'console']);
  assert.equal(service.summary(service.namespace('web')).unpublishedChanges, false);
  const b = JSON.parse(service.bundle('web', 'tr-cy').body);
  assert.deepEqual(b.chain, ['tr-CY', 'tr', 'en']);
  assert.deepEqual(b.strings, { bye: 'Bye', hello: 'Merhaba {name}', local: 'Kıbrıs' }, 'keys without any value are omitted');
  assert.equal(b.release, 1);
  assert.deepEqual(JSON.parse(service.bundle('web', 'en').body).strings, { bye: 'Bye', hello: 'Hello {name}', local: 'Island' });
  assert.throws(() => service.bundle('web', 'de'), fails('LOCALE_NOT_FOUND'));
  const etag = service.bundle('web', 'tr').etag;
  assert.match(etag, /^"[A-Za-z0-9_-]{32}"$/);

  // Draft edits do not reach the bundle until published.
  service.upsertKey('web', 'bye', { values: { en: 'Goodbye', tr: 'Hoşçakal' } }, 'x');
  assert.equal(service.bundle('web', 'tr').etag, etag);
  assert.deepEqual(service.release('web', 1).content.keys.bye.values, { en: 'Bye' }, 'release content is immutable');
  service.publish('web', {}, 'x');
  assert.notEqual(service.bundle('web', 'tr').etag, etag);
  assert.equal(JSON.parse(service.bundle('web', 'tr').body).strings.bye, 'Hoşçakal');

  service.upsertKey('web', 'hello', { values: { en: 'Hello {first}' } }, 'x');
  assert.throws(() => service.publish('web', {}, 'x'), (e) => fails('UNPUBLISHABLE')(e) && /** @type {any} */ (e).details.problems[0].key === 'hello');
  service.upsertKey('web', 'only.en', { values: { en: 'English only' } }, 'x');
  service.updateNamespace('web', { defaultLocale: 'tr' }, 'x');
  service.upsertKey('web', 'hello', { values: { tr: 'Merhaba {first}' } }, 'x');
  assert.throws(() => service.publish('web', {}, 'x'), (e) => fails('UNPUBLISHABLE')(e) && /** @type {any} */ (e).details.problems.some((/** @type {any} */ p) => p.key === 'only.en' && /no tr value/.test(p.reason)), 'values without a value in the new default block publishing');
});

test('rollback: new release with old content, optional draft restore, retention', () => {
  const { service, content, releases } = seeded({ RELEASE_RETENTION: '3' });
  service.upsertKey('web', 'title', { values: { en: 'One' } }, 'x');
  service.publish('web', {}, 'x');
  service.upsertKey('web', 'title', { values: { en: 'Two' } }, 'x');
  service.publish('web', {}, 'x');
  service.upsertKey('web', 'title', { values: { en: 'Three (draft)' } }, 'x');
  const r3 = service.rollback('web', { release: 1 }, 'console');
  assert.deepEqual([r3.number, r3.rollback_of, r3.note], [3, 1, 'rollback to release 1']);
  assert.equal(JSON.parse(service.bundle('web', 'en').body).strings.title, 'One');
  assert.equal(content.translation('web', 'title', 'en')?.value, 'Three (draft)', 'draft untouched by default');
  service.upsertKey('web', 'extra', { values: { en: 'x' } }, 'x');
  service.setLocale('web', 'de', {});
  service.rollback('web', { release: 2, restoreDraft: true }, 'x');
  assert.equal(content.translation('web', 'title', 'en')?.value, 'Two');
  assert.equal(content.key('web', 'extra'), undefined);
  assert.deepEqual(content.locales('web').map((l) => [l.locale, l.fallback]), [['en', null], ['tr', null], ['tr-CY', 'tr']]);
  assert.equal(service.summary(service.namespace('web')).unpublishedChanges, false);
  assert.deepEqual(releases.list('web', { limit: 10 }).map((r) => r.number), [4, 3, 2], 'only RELEASE_RETENTION kept');
  assert.throws(() => service.rollback('web', { release: 1 }, 'x'), fails('RELEASE_NOT_FOUND'));
  service.publish('web', {}, 'x');
  assert.equal(releases.latest('web')?.number, 5, 'numbers keep increasing after pruning');
});

test('import and export: flat and nested, report, no deletion, published source', () => {
  const { service } = seeded();
  const en = service.importLocale('web', 'en', { nav: { home: 'Home', cart: 'Cart ({count})' }, 'footer.copy': '© {year}', 'Bad': 'x', num: 5 }, 'x');
  assert.deepEqual(en, { locale: 'en', added: 3, updated: 0, unchanged: 0, invalidCount: 2, invalid: [{ key: 'num', reason: 'value must be a string or an object of strings' }, { key: 'Bad', reason: 'key must match [a-z0-9][a-z0-9._-]{0,127}' }] });
  const tr = service.importLocale('web', 'tr', { 'nav.home': 'Ana sayfa', 'nav.cart': 'Sepet', 'footer.copy': '© {year}', unknown: 'x' }, 'x');
  assert.deepEqual([tr.added, tr.updated, tr.unchanged, tr.invalidCount], [2, 0, 0, 2]);
  assert.match(tr.invalid.find((i) => i.key === 'nav.cart')?.reason ?? '', /placeholders/);
  assert.match(tr.invalid.find((i) => i.key === 'unknown')?.reason ?? '', /import en first/);
  const again = service.importLocale('web', 'en', { nav: { home: 'Home!' }, 'footer.copy': '© {year}' }, 'x');
  assert.deepEqual([again.added, again.updated, again.unchanged], [0, 1, 1]);
  assert.equal(service.content.translation('web', 'nav.cart', 'en')?.value, 'Cart ({count})', 'import never deletes');
  assert.throws(() => service.importLocale('web', 'de', {}, 'x'), fails('LOCALE_NOT_FOUND'));

  assert.deepEqual(service.exportLocale('web', 'en', { source: 'draft', nested: false }).strings, { 'footer.copy': '© {year}', 'nav.cart': 'Cart ({count})', 'nav.home': 'Home!' });
  assert.deepEqual(JSON.parse(JSON.stringify(service.exportLocale('web', 'tr', { source: 'draft', nested: true }).strings)), { footer: { copy: '© {year}' }, nav: { home: 'Ana sayfa' } });
  assert.throws(() => service.exportLocale('web', 'en', { source: 'published', nested: false }), fails('NOT_PUBLISHED'));
  service.publish('web', {}, 'x');
  service.importLocale('web', 'en', { nav: { home: 'Changed' } }, 'x');
  const pub = service.exportLocale('web', 'en', { source: 'published', nested: false });
  assert.deepEqual([pub.release, pub.strings['nav.home']], [1, 'Home!']);
  service.upsertKey('web', 'nav', { values: { en: 'Navigation' } }, 'x');
  assert.throws(() => service.exportLocale('web', 'en', { source: 'draft', nested: true }), fails('NESTED_CONFLICT'));
});

test('stats: keys, locales, missing, mismatched, last publish', () => {
  const { service } = seeded();
  service.createNamespace({ name: 'mobile', defaultLocale: 'en' }, 'x');
  service.upsertKey('web', 'a', { values: { en: 'A {x}', tr: 'A {x}' } }, 'x');
  service.upsertKey('web', 'b', { values: { en: 'B' } }, 'x');
  service.upsertKey('mobile', 'c', {}, 'x');
  service.publish('web', {}, 'console');
  service.upsertKey('web', 'a', { values: { en: 'A' } }, 'x');
  const s = service.stats();
  assert.deepEqual([s.namespaces, s.keys, s.locales, s.missing, s.mismatched, s.releases], [2, 3, 4, 4, 1, 1]);
  assert.deepEqual(s.lastPublish && [s.lastPublish.namespace, s.lastPublish.release, s.lastPublish.by], ['web', 1, 'console']);
  const web = s.items.find((i) => i.namespace === 'web');
  assert.deepEqual(web?.missingByLocale, { tr: 1, 'tr-CY': 2 });
  assert.equal(web?.unpublishedChanges, true);
  service.deleteNamespace('web');
  assert.equal(service.stats().namespaces, 1);
  assert.throws(() => service.bundle('web', 'en'), fails('NAMESPACE_NOT_FOUND'));
});

test('draft state: unpublished changes follow edits, publish and rollback', () => {
  const { service } = seeded();
  const unpublished = () => service.summary(service.namespace('web')).unpublishedChanges;
  service.upsertKey('web', 'a', { values: { en: 'A' } }, 'x');
  service.publish('web', {}, 'x');
  assert.equal(unpublished(), false);
  service.upsertKey('web', 'a', { values: { en: 'A' } }, 'x');
  service.importLocale('web', 'en', { a: 'A' }, 'x');
  assert.equal(unpublished(), false, 'writes that change nothing leave the draft clean');
  service.upsertKey('web', 'a', { values: { en: 'B' } }, 'x');
  assert.equal(unpublished(), true);
  service.publish('web', {}, 'x');
  service.rollback('web', { release: 1 }, 'x');
  assert.equal(unpublished(), true, 'live content is release 1, draft still says B');
  service.rollback('web', { release: 1, restoreDraft: true }, 'x');
  assert.equal(unpublished(), false);
});

test('events: publish and rollback announce the release; each with the release number', () => {
  /** @type {any[]} */ const out = [];
  const { service } = seeded({}, { publish: (/** @type {string} */ t, /** @type {any} */ d) => out.push([t, d]) });
  service.upsertKey('web', 'hello', { values: { en: 'Hello' } }, 'x');
  service.publish('web', {}, 'console');
  service.upsertKey('web', 'hello', { values: { en: 'Hi' } }, 'x');
  service.publish('web', {}, 'console');
  service.rollback('web', { release: 1 }, 'console');
  assert.deepEqual(out, [
    ['content.release.published', { namespace: 'web', release: 1, keyCount: 1, by: 'console' }],
    ['content.release.published', { namespace: 'web', release: 2, keyCount: 1, by: 'console' }],
    ['content.release.rolled_back', { namespace: 'web', release: 3, rollbackOf: 1, by: 'console' }],
  ]);
});
