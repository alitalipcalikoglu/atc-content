import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { createErrorHandler, registerInfo, registerOpenApi, registerProbes, registerRequestContext, requestOptions } from '@atc-web/atc-service-core/fastify';
import { ContentError } from '../domain/errors.js';
import { Actor } from './actor.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Schemas } from './schemas.js';
import { Views } from './views.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('../domain/content-service.js').ContentService} ContentService */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */

/**
 * HTTP surface: draft editing, import/export and releases (write role to change, read role to
 * look), plus published bundles for applications (read role, or anonymous when public bundles
 * are on).
 */
export class ContentApi {
  static READY_CACHE_MS = 10_000;
  static BUNDLE_CACHE_CONTROL = 'public, max-age=60';

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {ContentService} deps.service
   * @param {import('../store/content-store.js').ContentStore} deps.content
   * @param {import('../store/release-store.js').ReleaseStore} deps.releases
   * @param {import('../db.js').Database} deps.db
   * @param {string} deps.version
   * @param {import('../types.js').Logger} [deps.logger]
   * @param {import('@atc-web/atc-service-core/audit').AuditClient} [deps.audit]
   */
  constructor({ config, audit, service, content, releases, db, version, logger }) {
    this.config = config;
    this.audit = audit;
    this.service = service;
    this.content = content;
    this.releases = releases;
    this.db = db;
    this.version = version;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys, { publicReads: config.publicBundles });
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      ...requestOptions({ logger: this.logger, logLevel: config.logLevel }),
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    registerRequestContext(app, { trustProxy: config.trustProxy });
    app.decorateRequest('apiKey', null);
    app.setErrorHandler(createErrorHandler(ContentError));
    app.addHook('onSend', AuditClient.hook(this.audit));
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    });
    registerProbes(app, () => this.db.ping(), { cacheMs: ContentApi.READY_CACHE_MS });
    registerOpenApi(app, new URL('../../openapi.yaml', import.meta.url));
    registerInfo(app, {
      service: 'atc-content',
      version: this.version,
      capabilities: ['locale-fallback', 'placeholder-check', 'releases', 'bundle-etag', 'import-export', ...(config.publicBundles ? ['public-bundles'] : [])],
      schemaVersion: this.db.schemaVersion,
    });
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }

  /** @param {FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKey ? `key:${request.apiKey.id}` : `ip:${request.ip}`,
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    const s = this.service;
    const read = { preHandler: ApiKeyAuth.require('read') };
    const write = { preHandler: ApiKeyAuth.require('write') };
    const p = (/** @type {FastifyRequest} */ r) => /** @type {{ ns: string, key: string, locale: string, number: string }} */ (r.params);
    const who = new Actor(this.config.actorKeys);
    const actor = (/** @type {FastifyRequest} */ r) => who.of(r);
    const nsView = (/** @type {string} */ name) => { const n = s.namespace(name); return Views.namespace(n, s.summary(n)); };
    const keyView = (/** @type {string} */ ns, /** @type {string} */ key) => Views.key(s.key(ns, key), this.content.translationsOfKey(ns, key), s.namespace(ns).default_locale);
    const nsTarget = (/** @type {FastifyRequest} */ r) => ({ type: 'namespace', id: p(r).ns });
    const keyTarget = (/** @type {FastifyRequest} */ r) => ({ type: 'key', id: `${p(r).ns}/${p(r).key}` });

    // ---- namespaces
    api.get('/namespaces', read, async () => ({ items: this.content.namespaces().map((n) => Views.namespace(n, s.summary(n))) }));

    api.post('/namespaces', { config: { audit: AuditClient.route('atc-content.namespace.create', (_r, b) => ({ type: 'namespace', id: b.namespace.name }), (_r, b) => ({ defaultLocale: b.namespace.defaultLocale, locales: b.namespace.locales.map((/** @type {any} */ l) => l.locale) })) }, ...write, schema: { body: Schemas.createNamespace } }, async (request, reply) => {
      const row = s.createNamespace(/** @type {any} */ (request.body), actor(request));
      reply.header('location', `/v1/namespaces/${row.name}`);
      return reply.code(201).send({ namespace: nsView(row.name) });
    });

    api.get('/namespaces/:ns', { ...read, schema: { params: Schemas.nsParams } }, async (request) => ({ namespace: nsView(p(request).ns) }));

    api.patch('/namespaces/:ns', { config: { audit: AuditClient.route('atc-content.namespace.update', nsTarget, (r) => ({ patch: r.body })) }, ...write, schema: { params: Schemas.nsParams, body: Schemas.patchNamespace } }, async (request) => {
      s.updateNamespace(p(request).ns, /** @type {any} */ (request.body), actor(request));
      return { namespace: nsView(p(request).ns) };
    });

    api.delete('/namespaces/:ns', { config: { audit: AuditClient.route('atc-content.namespace.delete', nsTarget) }, ...write, schema: { params: Schemas.nsParams } }, async (request, reply) => {
      s.deleteNamespace(p(request).ns);
      return reply.code(204).send();
    });

    // ---- locales
    api.put('/namespaces/:ns/locales/:locale', { config: { audit: AuditClient.route('atc-content.locale.upsert', nsTarget, (r, b) => ({ locale: b.locale, fallback: /** @type {any} */ (r.body)?.fallback ?? null, created: b.created })) }, ...write, schema: { params: Schemas.localeParams, body: Schemas.putLocale } }, async (request, reply) => {
      const { created, locale } = s.setLocale(p(request).ns, p(request).locale, /** @type {any} */ (request.body ?? {}), actor(request));
      return reply.code(created ? 201 : 200).send({ created, locale, namespace: nsView(p(request).ns) });
    });

    api.delete('/namespaces/:ns/locales/:locale', { config: { audit: AuditClient.route('atc-content.locale.delete', nsTarget, (r) => ({ locale: p(r).locale })) }, ...write, schema: { params: Schemas.localeParams } }, async (request, reply) => {
      s.deleteLocale(p(request).ns, p(request).locale);
      return reply.code(204).send();
    });

    // ---- keys
    api.get('/namespaces/:ns/keys', { ...read, schema: { params: Schemas.nsParams, querystring: Schemas.keysQuery } }, async (request) => {
      const q = /** @type {Record<string, string|undefined>} */ (request.query);
      const ns = s.namespace(p(request).ns);
      const missing = q.missing ? s.localeOf(ns.name, q.missing) : undefined;
      const limit = q.limit ? Number(q.limit) : 50;
      const rows = this.content.listKeys(ns.name, { q: q.q, missing, after: q.cursor, limit: limit + 1 });
      const page = rows.slice(0, limit);
      return { items: page.map((k) => Views.key(k, this.content.translationsOfKey(ns.name, k.key), ns.default_locale)), nextCursor: rows.length > limit ? page.at(-1)?.key ?? null : null };
    });

    api.get('/namespaces/:ns/keys/:key', { ...read, schema: { params: Schemas.keyParams } }, async (request) => ({ key: keyView(p(request).ns, p(request).key) }));

    api.put('/namespaces/:ns/keys/:key', { config: { audit: AuditClient.route('atc-content.key.upsert', keyTarget, (r, b) => ({ created: b.created, locales: Object.keys(/** @type {any} */ (r.body)?.values ?? {}), description: /** @type {any} */ (r.body)?.description !== undefined })) }, ...write, schema: { params: Schemas.keyParams, body: Schemas.putKey } }, async (request, reply) => {
      const { created, mismatched } = s.upsertKey(p(request).ns, p(request).key, /** @type {any} */ (request.body ?? {}), actor(request));
      return reply.code(created ? 201 : 200).send({ created, mismatched, key: keyView(p(request).ns, p(request).key) });
    });

    api.delete('/namespaces/:ns/keys/:key', { config: { audit: AuditClient.route('atc-content.key.delete', keyTarget) }, ...write, schema: { params: Schemas.keyParams } }, async (request, reply) => {
      s.deleteKey(p(request).ns, p(request).key);
      return reply.code(204).send();
    });

    // ---- import / export
    api.post('/namespaces/:ns/import', { config: { audit: AuditClient.route('atc-content.translations.import', nsTarget, (_r, b) => ({ locale: b.locale, added: b.added, updated: b.updated, unchanged: b.unchanged, invalid: b.invalidCount })) }, ...write, schema: { params: Schemas.nsParams, body: Schemas.importBody } }, async (request) => {
      const b = /** @type {{ locale: string, strings: Record<string, unknown> }} */ (request.body);
      return s.importLocale(p(request).ns, b.locale, b.strings, actor(request));
    });

    api.get('/namespaces/:ns/export/:locale', { ...read, schema: { params: Schemas.localeParams, querystring: Schemas.exportQuery } }, async (request) => {
      const q = /** @type {{ source?: 'draft'|'published', format?: 'flat'|'nested' }} */ (request.query);
      return s.exportLocale(p(request).ns, p(request).locale, { source: q.source ?? 'draft', nested: q.format === 'nested' });
    });

    // ---- releases
    api.post('/namespaces/:ns/publish', { config: { audit: AuditClient.route('atc-content.release.publish', nsTarget, (_r, b) => ({ release: b.release.number, keys: b.release.keys })) }, ...write, schema: { params: Schemas.nsParams, body: Schemas.publish } }, async (request, reply) => {
      const row = s.publish(p(request).ns, /** @type {any} */ (request.body ?? {}), actor(request));
      return reply.code(201).send({ release: Views.release(row) });
    });

    api.post('/namespaces/:ns/rollback', { config: { audit: AuditClient.route('atc-content.release.rollback', nsTarget, (r, b) => ({ release: b.release.number, rollbackOf: b.release.rollbackOf, restoreDraft: /** @type {any} */ (r.body)?.restoreDraft === true })) }, ...write, schema: { params: Schemas.nsParams, body: Schemas.rollback } }, async (request, reply) => {
      const row = s.rollback(p(request).ns, /** @type {any} */ (request.body), actor(request));
      return reply.code(201).send({ release: Views.release(row) });
    });

    api.get('/namespaces/:ns/releases', { ...read, schema: { params: Schemas.nsParams, querystring: Schemas.releasesQuery } }, async (request) => {
      const q = /** @type {{ limit?: string, before?: string }} */ (request.query);
      s.namespace(p(request).ns);
      const limit = q.limit ? Number(q.limit) : 20;
      const rows = this.releases.list(p(request).ns, { limit: limit + 1, before: q.before ? Number(q.before) : undefined });
      const page = rows.slice(0, limit);
      return { items: page.map(Views.release), nextBefore: rows.length > limit ? String(page.at(-1)?.number) : null };
    });

    api.get('/namespaces/:ns/releases/:number', { ...read, schema: { params: Schemas.releaseParams } }, async (request) => {
      const { row, content } = s.release(p(request).ns, Number(p(request).number));
      return { release: { ...Views.release(row), content } };
    });

    // ---- bundles for applications
    api.get('/bundles/:ns/:locale', { config: { publicRead: true }, preHandler: ApiKeyAuth.require('read', { allowAnonymous: true }), schema: { params: Schemas.localeParams } }, async (request, reply) => {
      const { ns, locale } = p(request);
      const { body, etag } = s.bundle(ns, locale);
      reply.header('etag', etag).header('cache-control', ContentApi.BUNDLE_CACHE_CONTROL);
      if (ContentApi.matches(request.headers['if-none-match'], etag)) {
        s.countBundle(ns, 'notModified');
        return reply.code(304).send();
      }
      s.countBundle(ns, 'ok');
      return reply.type('application/json; charset=utf-8').send(body);
    });

    api.get('/stats', read, async () => s.stats());
  }

  /**
   * `If-None-Match` uses weak comparison (RFC 9110 13.1.2): `W/"x"` matches `"x"`, `*` matches any.
   * @param {string|undefined} header
   * @param {string} etag
   */
  static matches(header, etag) {
    if (!header) return false;
    return header.split(',').some((t) => { const v = t.trim(); return v === '*' || v.replace(/^W\//, '') === etag; });
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn', preHandler: ApiKeyAuth.require('read') }, async (_request, reply) => {
      const st = this.service.stats();
      const label = (/** @type {string} */ v) => v.replace(/[\\"\n]/g, '\\$&');
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP content_namespaces Namespaces.',
        '# TYPE content_namespaces gauge',
        `content_namespaces ${st.namespaces}`,
        '# HELP content_keys Draft keys per namespace.',
        '# TYPE content_keys gauge',
        ...st.items.map((i) => `content_keys{namespace="${label(i.namespace)}"} ${i.keys}`),
        '# HELP content_locales Configured locales per namespace.',
        '# TYPE content_locales gauge',
        ...st.items.map((i) => `content_locales{namespace="${label(i.namespace)}"} ${i.locales}`),
        '# HELP content_missing_translations Draft keys without a value, per namespace and locale.',
        '# TYPE content_missing_translations gauge',
        ...st.items.flatMap((i) => Object.entries(i.missingByLocale).map(([l, n]) => `content_missing_translations{namespace="${label(i.namespace)}",locale="${label(l)}"} ${n}`)),
        '# HELP content_mismatched_translations Draft values that block publishing (placeholder drift, no default value).',
        '# TYPE content_mismatched_translations gauge',
        ...st.items.map((i) => `content_mismatched_translations{namespace="${label(i.namespace)}"} ${i.mismatched}`),
        '# HELP content_release Latest release number per namespace (0 = never published).',
        '# TYPE content_release gauge',
        ...st.items.map((i) => `content_release{namespace="${label(i.namespace)}"} ${i.release ?? 0}`),
        '# HELP content_last_publish_timestamp_seconds Time of the latest release per namespace.',
        '# TYPE content_last_publish_timestamp_seconds gauge',
        ...st.items.filter((i) => i.publishedAt).map((i) => `content_last_publish_timestamp_seconds{namespace="${label(i.namespace)}"} ${Math.floor(Date.parse(String(i.publishedAt)) / 1000)}`),
        '# HELP content_bundle_requests_total Bundle requests since start, per namespace and result.',
        '# TYPE content_bundle_requests_total counter',
        ...[...this.service.bundleRequests].flatMap(([ns, c]) => [`content_bundle_requests_total{namespace="${label(ns)}",result="ok"} ${c.ok}`, `content_bundle_requests_total{namespace="${label(ns)}",result="not_modified"} ${c.notModified}`]),
        '# HELP content_process_uptime_seconds Process uptime.',
        '# TYPE content_process_uptime_seconds gauge',
        `content_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
