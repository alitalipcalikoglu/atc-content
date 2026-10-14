# Operations

## Probes and identity

```bash
curl -s $CONTENT/health        # {"status":"ok"}  liveness, no I/O
curl -s $CONTENT/ready         # {"status":"ok"}  database ping, cached 10 s; 503 when it fails
curl -s $CONTENT/v1/info       # service, version, apiVersion, capabilities, schemaVersion, serviceCore
curl -s $CONTENT/openapi.yaml  # the API contract
```

## Metrics

```bash
curl -s -H "Authorization: Bearer $READ_KEY" $CONTENT/metrics
```

```
content_namespaces 2
content_keys{namespace="web"} 312
content_locales{namespace="web"} 3
content_missing_translations{namespace="web",locale="tr-CY"} 26
content_mismatched_translations{namespace="web"} 1
content_release{namespace="web"} 5
content_last_publish_timestamp_seconds{namespace="web"} 1791968400
content_bundle_requests_total{namespace="web",result="ok"} 1843
content_bundle_requests_total{namespace="web",result="not_modified"} 9120
content_process_uptime_seconds 86400
```

`content_bundle_requests_total` is per process and resets on restart. A rising `content_mismatched_translations` means someone changed source text and a publish will be refused.

## Running

```bash
cp .env.example .env    # set CONTENT_API_KEYS
npm ci --omit=dev
pm2 start ecosystem.config.cjs     # fork mode, one process per SQLite file, wait_ready
```

Docker:

```bash
docker build -t atc-content .
docker run -d -p 3013:3013 -v content-data:/data -e CONTENT_API_KEYS=atc-console:$(openssl rand -hex 32) atc-content
```

## Backups

All state is the SQLite file at `DB_PATH` (default `./data/content.db`, `/data/content.db` in Docker). Take an online copy with:

```bash
sqlite3 data/content.db "VACUUM INTO 'backup/content-$(date +%F).db'"
```

Restore: stop the service, replace the file (remove stale `-wal`/`-shm`), start. Migrations run forward on start and snapshot the file first.

## Pitfalls

- Run exactly one process per database file; bundle caches and request counters are per process.
- `SIGTERM` drains in-flight requests, flushes audit events and closes the database; PM2's `kill_timeout` (35 s) is above the internal 30 s force exit.
