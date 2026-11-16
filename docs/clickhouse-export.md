# Optional ClickHouse long-term store (v2 tables; v2/v3 facts)

Settings → Data → ClickHouse keeps a long-term copy of Spillway's local stores; local retention stays short-term. Export, each store and content inclusion are independently opt-in; turning export on selects every store. Configure an HTTP(S) origin, database and `tablePrefix` (default `spillway`). Check (and Create tables, offered when Check finds them missing) handles both `<prefix>_facts` and `<prefix>_pieces`; types compare without layout whitespace, since ClickHouse 26 pretty-prints named tuples. Prefixes are simple SQL identifiers limited to 56 characters so the longest suffix fits the 63-character identifier limit.

## First setup

Spillway never creates the database or user. On the server:

```sql
CREATE DATABASE spillway;
CREATE USER spillway IDENTIFIED BY '<password>' HOST IP '192.168.0.0/16';
GRANT ALL ON spillway.* TO spillway;
```

Then in Spillway: enter endpoint, database, username and password, Save, Check (then Create tables if offered), and turn on Export requests. Named tuples in `request_pieces` are sent as JSON objects, the JSONEachRow default. Errors report status only: 401/403 means credentials or grants; 404 means the database or tables are missing.

Credentials remain in `secrets.bin` and are sent only in ClickHouse authentication headers. Redirects are rejected. Diagnostics hide server responses. Changing destination discards the unsent queue (counted as Discarded) and re-sends everything stored locally; delivery pauses during the change. Local unreleased v2 state, outbox and triggers are dropped once with no migration; remote v2 tables are left alone. A fresh local source identity is created.

## Stores and records

| Store | Kinds | Key (`record_key`) |
|---|---|---|
| Traces | `attempt`, legacy `capture`, `finalized`, `snapshot`, v3 `capture-start`, `capture-chunk`, `capture-end` (immutable facts) | empty |
| Requests | `request` (Activity `ActivityEvent`: tokens, cost, account, effort, latency, status), `request-settings` | local row id, settings hash |
| Conversation titles | `conversation-title` (`{sessionId,title}`) from T3 Code, Codex and Claude Code | session ID |
| Hourly and daily totals | `total` (`{key,total}`); `at` is the hour start, or local midnight for day totals | total key |
| Usage limits | `usage-sample`, `usage-window`, `usage-span` | sample time; credential\|window\|first reset; credential\|window\|start |
| Drift checks | `canary` | result id |
| Evals and thinking tests | `eval-case` (one per revision; `capture` only with content), `thinking-test` | `id:revision`, setting key |

Keyed records change locally (usage merges, repricing, running totals, re-run tests), so each change queues the record again; the newest `seq` per `(source_id, kind, record_key)` is current. SQLite triggers queue a reference on every insert or update of an exported table, so no write path skips export; delivery reads the row's current value. Usage history lives in main-process files and titles in other apps' data, so both are mirrored into `clickhouse_mirror` for the same path. Titles of sessions active in the last day are re-read every five minutes; all retained sessions on startup and when export or the store turns on. Spillway never deletes, alters rows in or truncates ClickHouse tables; local deletes (retention, clears) are not exported, and removing remote data is the user's choice. A queued record whose row is gone before upload counts as Discarded. Enabling export or a store, or changing destination, backfills existing rows.

```sql
-- Current requests.
SELECT * FROM spillway_facts FINAL WHERE kind = 'request'
ORDER BY seq DESC LIMIT 1 BY source_id, record_key;
```

## Facts and content references

`attempt`, `capture`, `finalized` and backfill `snapshot` facts are appended transactionally with archive writes. The encrypted outbox stores metadata and immutable revision range references, never another body copy. Unacknowledged facts are never evicted by byte budget. The 1 GiB threshold only pauses further backfill; live capture references continue queuing. Facts have monotonically increasing sequence IDs. Enabling export or content, or changing destination, backfills retained entries in `(at,id)` order. Clear queue stops backfill; archive clear also clears the queue. Neither retracts remote data.

Request pieces are sent on demand, before the facts referencing them. Preparation includes each unsent request piece once per batch. After the required INSERTs succeed, acknowledgment marks only delivered pieces sent and deletes acknowledged facts. A pieces-only batch can be acknowledged independently before its referencing fact is ready. A destination change resets all sent flags. This resync rule covers dropped or cleared queue rows and backfill without special handling: a piece remains unsent until delivery is acknowledged. Superseded revisions can reference earlier immutable pieces.

Threads with queued body references are retained until delivery is acknowledged, including while capture or export is disabled. Pending backfill protects retained content while references are queued. `contentExpired` and `source-expired` remain readable for historical losses; new retention cannot expire queued content. Metadata-cap deletion does not remove pieces. Policies are `included`, `metadata-only`, `source-unavailable` (capture disabled or absent source), `omitted-size-limit`, and `source-expired`. A backfill snapshot of an entry whose text expired before it was queued sends `source-unavailable` with `capture_state='expired'`; `contentExpired` counts only content lost while queued.

`record_json` is metadata only. Legacy included requests use `request_pieces`; responses and structured frames use `response` and `frames_json`. V3 chunks use the representation below. Exported content is original data, independent of UI email masking. Local body retention resumes after confirmed delivery. Explicit Clear still removes queued content; destination changes keep their existing reset/backfill semantics.

## Remote schema

```sql
CREATE TABLE IF NOT EXISTS default.spillway_facts (
 schema_version UInt16,
 source_id String,
 source_label LowCardinality(String),
 seq UInt64,
 kind LowCardinality(String),
 record_key String,
 trace_id String,
 thread_id String,
 at DateTime64(3, 'UTC'),
 capture_state LowCardinality(String),
 content_policy LowCardinality(String),
 request_pieces Array(Tuple(piece_seq UInt64, offset UInt32, length UInt32)),
 response String CODEC(ZSTD(3)),
 frames_json String CODEC(ZSTD(3)),
 record_json String CODEC(ZSTD(3))
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(at) ORDER BY (source_id, at, seq);

CREATE TABLE IF NOT EXISTS default.spillway_pieces (
 source_id String,
 thread_id String,
 seq UInt64,
 at DateTime64(3, 'UTC'),
 bytes String CODEC(ZSTD(3))
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(at) ORDER BY (source_id, thread_id, seq);
```

Checks require exact columns and types, no defaults, these sorting/partition keys, and an unversioned ReplacingMergeTree-family engine. Schema v1 facts tables (no `record_key`) get Upgrade tables, which runs `ALTER TABLE … ADD COLUMN IF NOT EXISTS record_key String AFTER kind`; existing rows read `''`. Shared and Replicated variants accept quoted coordination arguments. `schema_version` is 2 for legacy/keyed facts and 3 for new raw-wire chunk facts. Physical table columns remain schema v2; no remote ALTER is required for capture v3. Piece sequence IDs are immutable local piece IDs and never reused. Source identity survives clears; replacing the database changes it. Source labels are applied at preparation time.

## Delivery and reconstruction

Batches target at most 1,000 total piece/fact rows and 8 MiB of uncompressed JSONEachRow lines. New raw pieces are at most 64 KiB before base64, so arbitrary body sizes span bounded batches without omission. A legacy piece/fact larger than the batch target is sent alone, preserving historical bytes. Invalid/oversized newly queued metadata is rejected and counted; retained content is never omitted to fit a batch. Pieces INSERT first, facts second, each compressed with `Content-Encoding: zstd`. Both use `async_insert=1`, `wait_for_async_insert=1`, and `wait_end_of_query=1`. Acknowledgment follows both complete empty responses. Failure or uncertain delivery retains the queue and sent flags for retry. Inserts add one second per 32 KiB to the 15-second diagnostic timeout; retries use exponential backoff capped at five minutes with equal jitter. Successful delivery drains immediately.

Delivery is at least once. Use `FINAL` or distinct source/sequence identities; facts are not request counts. Offsets are zero-based bytes in the app. ClickHouse `substring` is one-based, hence `offset + 1`:

A trace can have several facts (capture revisions, backfill snapshots), so rebuild one fact, chosen by `(source_id, seq)`:

```sql
-- Latest fact with content for a trace.
SELECT source_id, max(seq) AS seq FROM spillway_facts FINAL
WHERE trace_id = {t:String} AND content_policy = 'included' GROUP BY source_id;

-- That fact's request body.
SELECT p.seq, arrayStringConcat(arrayMap(x -> x.2, arraySort(x -> x.1, groupArray((p.i, substring(c.bytes, p.offset + 1, p.length)))))) AS request
FROM (SELECT source_id, seq, pc.piece_seq AS piece_seq, pc.offset AS offset, pc.length AS length, i
      FROM spillway_facts FINAL ARRAY JOIN request_pieces AS pc, arrayEnumerate(request_pieces) AS i
      WHERE source_id = {s:String} AND seq = {seq:UInt64}) AS p
JOIN spillway_pieces AS c FINAL ON c.source_id = p.source_id AND c.seq = p.piece_seq
GROUP BY p.seq;
```

The synthetic demo destination supports both tables, zstd INSERT bodies, schema checks, retries, partial writes, disconnects and delayed responses without real credentials.


## Complete raw-wire captures (fact version 3)

A capture appends `capture-start`, `capture-chunk` and `capture-end` facts. `record_json` carries the capture UUID/epoch and original journal sequence; chunk metadata adds direction, zero-based direction byte offset, WebSocket message index/type/time/end, `rawBytes`, and `representation: "base64-wire-v2"`. For each chunk, `request_pieces` references its base64 text in the pieces table. The field is a generic chunk reference in v3, including response chunks. Decode each chunk independently before concatenating bytes: padding makes concatenated base64 strings invalid. Empty message markers have zero raw bytes and no pieces. `response` and `frames_json` are empty for these facts.

`capture-end` contains observed request/response byte counts, SHA-256 hashes and message count. Only a terminal `complete` state certifies a finalized observed exchange. Partial restart/disconnect/storage-failure records must remain partial. Raw HTTP bodies retain original content encoding; WebSocket binary messages are lossless application bytes. Content policies still require the separate export-body opt-in. Changing the recording toggle never strips bodies already queued for export.

At-least-once delivery and backfill can produce several facts for one original chunk. Deduplicate facts by `(source_id,seq)` first, then select the newest fact per `(source_id, captureId, epoch, original journal sequence)` from `record_json`. Deduplicate pieces with FINAL as before. A request is not a fact count.

For one trace, this bounded example returns decoded chunks in original journal order. Concatenate per direction for HTTP; group by message index and preserve message boundaries for WebSocket. Verify total bytes and hashes against the newest `capture-end` before calling reconstruction complete.

```sql
SELECT f.journal_seq, f.direction,
       base64Decode(substring(p.bytes, f.offset + 1, f.length)) AS wire_chunk
FROM (
  SELECT JSONExtractUInt(record_json, 'sequence') AS journal_seq,
         JSONExtractString(record_json, 'chunk', 'direction') AS direction,
         pc.piece_seq AS piece_seq, pc.offset AS offset, pc.length AS length,
         source_id
  FROM (
    SELECT * FROM spillway_facts FINAL
    WHERE trace_id = {t:String} AND kind = 'capture-chunk'
      AND content_policy = 'included'
    ORDER BY seq DESC
    LIMIT 1 BY source_id, JSONExtractString(record_json, 'captureId'),
               JSONExtractString(record_json, 'epoch'), JSONExtractUInt(record_json, 'sequence')
  ) ARRAY JOIN request_pieces AS pc
) AS f
JOIN spillway_pieces AS p FINAL
  ON p.source_id = f.source_id AND p.seq = f.piece_seq
ORDER BY f.journal_seq;
```

No server configuration or remote deletion is performed by this change. Body size is independent of insert size. Capture, export and search/display limits are separate: display/search previews can be limited while complete original bytes remain retained and exported.
