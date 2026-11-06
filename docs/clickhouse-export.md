# Optional ClickHouse event destination (schema v2)

Settings → Data → ClickHouse exports immutable archive facts from the encrypted Activity database. Export is off by default. Save an HTTP(S) origin, existing database and table, then use Check or Create table. Delivery validates the schema once per destination, refreshing after an error, stop/start or explicit diagnostic. It never creates tables automatically.

Credentials stay in `secrets.bin` and travel only in `X-ClickHouse-User` / `X-ClickHouse-Key` headers. Redirects are rejected. HTTPS protects credentials and content in transit. Diagnostics do not expose server response bodies or captured content. A destination change is rejected while rows remain: clear the upload queue first. Reconfiguration pauses and awaits the uploader before changing settings or credentials.

## Facts and owned outbox

Each accepted archive input appends an independent fact in the same SQLite transaction:

- `attempt`: newly inserted proxy attempt detail and event session/model/provider/client metadata.
- `capture`: one accepted, sequenced proxy capture record, including HTTP/WebSocket metadata and available request, response and frames.
- `finalized`: local settlement of a pending capture after archive reopen, capture disable, proxy restart or capture timeout; records the new state and reason.
- `snapshot`: retained archive detail copied by incremental backfill, with available content separated from metadata.

Facts have durable, monotonically increasing `seq` values. Capture sequence replay produces no new fact. Retention expiry and archive metadata-cap deletion produce no facts and never delete outbox rows. This prevents archive pruning during an outage from losing already queued exports (#118).

The outbox budget is 1 GiB, equal to the archive's maximum configurable body budget. Oldest rows are dropped when new facts exceed it, incrementing Discarded. Metadata-only rows larger than the 8 MiB batch limit are skipped and counted as both Discarded and Oversized. Invalid timestamps are skipped and counted as Discarded. There is no identity-count queue cap.

Enabling export, changing destination while enabled, or enabling Include captured content starts backfill over retained entries in `(at,id)` order. Each preparation appends up to 1,000 snapshots or one 8 MiB page; backfill pauses at the outbox budget. Queue row and byte totals are maintained by insert/delete triggers, so ingestion and backfill do not scan the outbox to measure it. Clear queue stops backfill. Snapshot facts can overlap live facts and represent archive state, not additional request attempts.

## Content policy and local residuals

Content is selected at send time using current settings:

- `included`: Include captured content and archive body capture are both on, and the fact has content.
- `metadata-only`: Include captured content is off.
- `source-unavailable`: content export is on but archive capture is off or this fact has no content.
- `omitted-size-limit`: including content would exceed the 8 MiB line limit; metadata is sent instead.

`record_json` contains fact metadata merged with request, response and frames only when included. Original timestamps stay in the record. Exported metadata is original data, independent of UI email masking. Client-log prompts and provider-hidden content are not exported.

Unsent rows outlive archive retention. Disabling capture or content export stops sending content, but queued rows keep their content locally until sent, cleared or dropped by budget. Disabling export pauses delivery and new fact collection while preserving queued rows. Archive clear and Activity clear also empty the outbox and count discarded rows. Clear queue leaves the archive intact. These actions never retract remote copies; cancellation cannot recall an already received insert.

## Remote schema

```sql
CREATE TABLE IF NOT EXISTS `default`.`spillway_events_v2` (
    schema_version UInt16,
    source_id String,
    source_label String,
    seq UInt64,
    kind LowCardinality(String),
    trace_id String,
    at DateTime64(3, 'UTC'),
    capture_state LowCardinality(String),
    content_policy LowCardinality(String),
    record_json String
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(at)
ORDER BY (source_id, at, seq);
```

Validation requires exactly these columns/types, no defaults, the specified partition and sorting keys, and an unversioned ReplacingMergeTree-family engine. Plain, Shared and Replicated variants are accepted, with optional quoted coordination arguments. `schema_version` is 2. `at` is sent as UTC `YYYY-MM-DD HH:MM:SS.mmm`.

`source_id` belongs to the Activity database and survives clears. Replacing the database creates a new source identity. Optional Source label is trimmed, limited to 64 characters without control characters, and applied from current config on every prepared line. It identifies an installation for people; deduplication uses `(source_id, seq)`.

## Delivery and queries

Preparation streams immutable rows in sequence order, at most 1,000 rows or 8 MiB, stopping at the first row that would exceed the byte limit. Content is read from SQLite only when both content export and archive body capture are on. No frozen payload table is stored. Acknowledgment deletes only rows through the batch's last sequence at the current destination; facts arriving during upload remain queued. Identical rows and settings produce identical retry payloads.

HTTP inserts use `async_insert=1`, `wait_for_async_insert=1` and `wait_end_of_query=1`. Acknowledgment waits for the entire successful, empty response. HTTP errors, exception headers, nonempty insert responses and interrupted responses retain rows. Diagnostics have a 15-second timeout; inserts add one second per 32 KiB. Failures persist attempts, a generic error and exponential backoff, capped at five minutes with equal jitter between half and all of the delay. Retry removes the delay. Successful delivery immediately drains the next batch; idle/backoff checks occur every three seconds.

Delivery is at least once. Use `FINAL` or distinct `(source_id, seq)` identities for exact fact counts; raw insert counts can include retries. Facts are not request counts.

```sql
SELECT kind, count()
FROM default.spillway_events_v2 FINAL
GROUP BY kind;

SELECT count()
FROM (
    SELECT DISTINCT source_id, seq
    FROM default.spillway_events_v2
);

-- Latest observed capture state per trace; attempts have no capture state.
SELECT source_id, trace_id, argMax(capture_state, seq) AS latest_capture_state
FROM default.spillway_events_v2
WHERE kind IN ('capture', 'finalized', 'snapshot')
GROUP BY source_id, trace_id;
```

The feature is unreleased: opening v2 drops v1 state, queue, batch and exporter triggers without migration. The synthetic `pnpm demo -- --clickhouse` destination supports schema checks, retries, partial writes, disconnects and delayed responses without real credentials or remote storage.
