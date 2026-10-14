import { Config } from './config.js';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { Lifecycle } from '@atc-web/atc-service-core/lifecycle';
import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Database } from './db.js';
import { ContentService } from './domain/content-service.js';
import { ContentApi } from './http/content-api.js';
import { ContentStore } from './store/content-store.js';
import { ReleaseStore } from './store/release-store.js';
import { EventPublisher } from './events/event-publisher.js';

/**
 * Composition root: wires configuration, storage, domain and HTTP, and owns the process lifecycle.
 */
export class Application {
  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.version = readServiceVersion(import.meta.url);
    this.audit = new AuditClient({ target: config.audit });
    this.publisher = new EventPublisher({ source: 'atc-content', target: config.webhookOut });
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
    this.content = new ContentStore(this.db);
    this.releases = new ReleaseStore(this.db);
    this.service = new ContentService({ db: this.db, content: this.content, releases: this.releases, limits: config.limits, publisher: this.publisher });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
  }

  /** Build from `process.env`; exits with a readable message on bad configuration. */
  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config } = this;
    const api = new ContentApi({ config, audit: this.audit, publisher: this.publisher, service: this.service, content: this.content, releases: this.releases, db: this.db, version: this.version });
    const app = await api.build();
    this.app = app;
    const { shutdown } = Lifecycle.install({
      forceExitMs: 30_000,
      log: app.log,
      steps: [
        () => this.app?.close(),
        () => this.publisher.close(),
        () => this.audit.close(),
        () => this.db.close(),
      ],
    });
    this.shutdown = shutdown;
    this.audit.logger = app.log;
    this.publisher.logger = app.log;
    this.audit.start();
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ tls: config.tls !== null, publicBundles: config.publicBundles, namespaces: this.content.namespaces().length }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    if (process.send) process.send('ready'); // PM2 wait_ready
  }
}
