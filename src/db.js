import { Database as CoreDatabase } from '@atc-web/atc-service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
  static MIGRATIONS = [
    `
    CREATE TABLE namespaces (
      name             TEXT PRIMARY KEY,
      default_locale   TEXT NOT NULL,
      description      TEXT NOT NULL DEFAULT '',
      created_by       TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      -- Last change to the draft (locales, keys, values); compared with the latest release.
      draft_updated_at INTEGER NOT NULL
    );

    CREATE TABLE locales (
      ns         TEXT NOT NULL REFERENCES namespaces(name) ON DELETE CASCADE,
      locale     TEXT NOT NULL,
      fallback   TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (ns, locale)
    );

    CREATE TABLE keys (
      ns          TEXT NOT NULL REFERENCES namespaces(name) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (ns, key)
    );

    CREATE TABLE translations (
      ns           TEXT NOT NULL,
      key          TEXT NOT NULL,
      locale       TEXT NOT NULL,
      value        TEXT NOT NULL,
      -- Sorted, comma-joined placeholder names; compared against the default locale's.
      placeholders TEXT NOT NULL,
      updated_by   TEXT NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (ns, key, locale),
      FOREIGN KEY (ns, key) REFERENCES keys(ns, key) ON DELETE CASCADE,
      FOREIGN KEY (ns, locale) REFERENCES locales(ns, locale) ON DELETE CASCADE
    );
    CREATE INDEX translations_locale ON translations (ns, locale);

    -- Immutable published snapshots; content is the whole namespace as JSON.
    CREATE TABLE releases (
      ns          TEXT NOT NULL REFERENCES namespaces(name) ON DELETE CASCADE,
      number      INTEGER NOT NULL,
      note        TEXT NOT NULL DEFAULT '',
      rollback_of INTEGER,
      key_count   INTEGER NOT NULL,
      content     TEXT NOT NULL,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (ns, number)
    );
    `,
  ];
}
