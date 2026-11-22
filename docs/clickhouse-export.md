# Optional ClickHouse long-term store (v2 tables; v2â€“v4 facts)

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
| Traces | `attempt`, legacy `capture`, `finalized`, `snapshot`, wire `capture-start`, `capture-chunk`, `capture-end` (immutable facts) | empty |
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

## Read-through

Activity Overview reads exported totals before local midnight of the earliest local total's day. With no local totals, it reads the full selected range. Requests reads days strictly before the local request retention cutoff, with 30 local days per summary window. Day summaries omit cost and indicate whether more history exists.

Reads include all source IDs in the facts table. Within each bounded range and kind, Spillway selects the highest sequence for each `(source_id, record_key)`, so retries and repeated exports of a record count once. Requests also key on `at`, so a local row ID reused after Clear activity stays a separate request.

Limits are 10,000 total rows per range, 5,000 request rows per day before filtering, 10,000 summary groups per window, and 16 MiB per response. Total and request reads report truncation. A summary window that exceeds its cap reports unavailability.

Read-through runs only SELECTs and never imports data into the local database. Results distinguish disabled or unconfigured export (`off`) from a failed configured read (`unavailable`). Errors show status only.

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

Checks require exact columns and types, no defaults, these sorting/partition keys, and an unversioned ReplacingMergeTree-family engine. Schema v1 facts tables (no `record_key`) get Upgrade tables, which runs `ALTER TABLE … ADD COLUMN IF NOT EXISTS record_key String AFTER kind`; existing rows read `''`. Shared and Replicated variants accept quoted coordination arguments. `schema_version` is 2 for legacy/keyed facts, 3 for base64-wire chunks and capture boundaries, and 4 for raw-wire chunks. All use the schema v2 tables. Piece sequence IDs identify immutable bytes. Source identity survives clears; replacing the database changes it. Source labels are applied at preparation time.

[Historical conversion](clickhouse-history-migration.md) describes how to build and verify shadow tables for eligible v3 captures.

## Delivery and reconstruction

Batches target at most 1,000 total piece/fact rows and 8 MiB of uncompressed encoded rows. Wire pieces are at most 64 KiB before any encoding, so arbitrary body sizes span bounded batches without omission. A legacy piece/fact larger than the batch target is sent alone, preserving historical bytes. Invalid/oversized newly queued metadata is rejected and counted; retained content is never omitted to fit a batch. Each batch inserts legacy/base64 pieces as JSONEachRow, raw pieces as RowBinary, then facts as JSONEachRow. Each request uses `Content-Encoding: zstd`, `async_insert=1`, `wait_for_async_insert=1`, and `wait_end_of_query=1`. Acknowledgment follows a complete empty response for every insert. Failure or uncertain delivery retains the queue and sent flags for retry. Inserts add one second per 32 KiB to the 15-second diagnostic timeout; retries use exponential backoff capped at five minutes with equal jitter. Successful delivery drains immediately.

Delivery is at least once. Use `FINAL` or distinct source/sequence identities; facts are not request counts. Offsets are zero-based bytes in the app. ClickHouse `substring` is one-based, hence `offset + 1`:

For a legacy v2 trace, rebuild one fact chosen by `(source_id, seq)`. The trace may have several revisions and snapshots.

```sql
-- Latest fact with content for a trace.
SELECT source_id, max(seq) AS seq FROM spillway_facts FINAL
WHERE trace_id = {t:String} AND schema_version = 2 AND content_policy = 'included' GROUP BY source_id;

-- That fact's request body.
SELECT p.seq, arrayStringConcat(arrayMap(x -> x.2, arraySort(x -> x.1, groupArray((p.i, substring(c.bytes, p.offset + 1, p.length)))))) AS request
FROM (SELECT source_id, seq, pc.piece_seq AS piece_seq, pc.offset AS offset, pc.length AS length, i
      FROM spillway_facts FINAL ARRAY JOIN request_pieces AS pc, arrayEnumerate(request_pieces) AS i
      WHERE source_id = {s:String} AND seq = {seq:UInt64} AND schema_version = 2) AS p
JOIN spillway_pieces AS c FINAL ON c.source_id = p.source_id AND c.seq = p.piece_seq
GROUP BY p.seq;
```

The synthetic demo destination supports both tables, zstd INSERT bodies, schema checks, retries, partial writes, disconnects and delayed responses without real credentials.


## Reconstructing wire captures (facts v3 and v4)

A capture appends `capture-start`, `capture-chunk` and `capture-end` facts. The chunk record contains the capture UUID, epoch, original journal sequence, direction, zero-based direction offset, WebSocket message index/type/time/end, and `rawBytes`. Its generic `request_pieces` field also references response chunks. Empty WebSocket messages have zero raw bytes and no piece reference. The `response` and `frames_json` columns are empty.

- V3 chunks reference base64 text with `representation: "base64-wire-v2"`. Their reference lengths are in base64 bytes. Decode each chunk separately before concatenating.
- V4 chunks reference original bytes with `representation: "raw-wire-v1"`. Their references have offset zero and length `rawBytes`. The piece ID sets the high bit of the original local ID, giving raw pieces an independent key in the same table. Preserve those `UInt64` values as decimal strings or 64-bit integers in clients.

**Raw bytes for new captures** is off by default. Enable it after updating reconstruction queries and clients. Each capture binds to its format when its start is ingested. Toggling the setting affects future starts. Queued rows and subsequent backfills keep their bound format. Use Clear outbox to discard queued rows deliberately. An older writer can replay retained chunks as v3 using a separate piece ID. A reader must therefore choose the encoding for each chunk fact.

Raw HTTP bodies preserve their original content encoding. WebSocket binary messages preserve application bytes. Body export still requires its own opt-in. Only a terminal `complete` record certifies a finalized observed exchange. Keep partial captures labeled partial.

Select a specific capture by source ID, trace ID, capture UUID and epoch. The query returns `journal_seq UInt64, chunk String, wire_bytes String` in RowBinary. It collapses transport retries with `FINAL`, then takes the newest included fact for each original journal sequence. Pieces match on `(source_id, thread_id, piece_seq)`, so ClickHouse can skip unrelated threads. Zero-length markers survive the joins. Unsupported encodings, missing pieces and mismatched extents fail the query.

```sql
WITH
  chunks AS (
    SELECT source_id, thread_id, schema_version, request_pieces,
           JSONExtractUInt(record_json, 'sequence') AS journal_seq,
           JSONExtractRaw(record_json, 'chunk') AS chunk,
           JSONHas(record_json, 'rawBytes') AS has_raw_size,
           JSONExtractUInt(record_json, 'rawBytes') AS raw_size,
           JSONExtractString(record_json, 'representation') AS representation
    FROM spillway_facts FINAL
    WHERE source_id = {source:String} AND trace_id = {trace:String}
      AND JSONExtractString(record_json, 'captureId') = {capture:String}
      AND JSONExtractString(record_json, 'epoch') = {epoch:String}
      AND kind = 'capture-chunk' AND content_policy = 'included'
    ORDER BY seq DESC LIMIT 1 BY journal_seq
  ),
  refs AS (
    SELECT *, length(request_pieces) AS piece_count,
           ref.piece_seq AS piece_seq, ref.offset AS piece_offset, ref.length AS piece_length
    FROM chunks LEFT ARRAY JOIN request_pieces AS ref
  ),
  matched_pieces AS (
    SELECT source_id, thread_id, seq, bytes
    FROM spillway_pieces FINAL
    WHERE source_id = {source:String}
      AND thread_id IN (SELECT thread_id FROM chunks)
  ),
  decoded AS (
    SELECT f.*, p.seq AS stored_seq,
           substring(p.bytes, f.piece_offset + 1, f.piece_length) AS stored_bytes,
           if(f.schema_version = 3, tryBase64Decode(stored_bytes), stored_bytes) AS wire_bytes
    FROM refs AS f LEFT JOIN matched_pieces AS p
      ON f.source_id = p.source_id AND f.thread_id = p.thread_id AND f.piece_seq = p.seq
  )
SELECT journal_seq, chunk, wire_bytes
FROM decoded
WHERE throwIf(
    schema_version NOT IN (3, 4)
    OR representation != if(schema_version = 4, 'raw-wire-v1', 'base64-wire-v2')
    OR NOT has_raw_size
    OR piece_count != (raw_size > 0)
    OR length(wire_bytes) != raw_size
    OR (raw_size > 0 AND (
      stored_seq = 0 OR bitTest(piece_seq, 63) != (schema_version = 4)
      OR piece_offset != 0 OR length(stored_bytes) != piece_length
      OR (schema_version = 3 AND base64Encode(wire_bytes) != stored_bytes)
      OR (schema_version = 4 AND piece_length != raw_size)
    )),
    'Invalid wire capture chunk'
  ) = 0
ORDER BY journal_seq
SETTINGS join_use_nulls = 0
FORMAT RowBinary;
```

Use the newest terminal fact for the same identity to verify the capture:

```sql
SELECT capture_state, record_json
FROM spillway_facts FINAL
WHERE source_id = {source:String} AND trace_id = {trace:String}
  AND JSONExtractString(record_json, 'captureId') = {capture:String}
  AND JSONExtractString(record_json, 'epoch') = {epoch:String}
  AND kind = 'capture-end'
ORDER BY seq DESC LIMIT 1;
```

Process chunks in journal order and verify contiguous offsets per direction, total `requestBytes` and `responseBytes`, and the two SHA-256 hashes from the terminal record. For WebSocket, also verify frame counts and continuations, including empty messages, using `frame`, `type`, `at` and `end` from the chunk JSON. Missing terminal metadata or a mismatch means reconstruction is incomplete.

No server configuration or remote deletion is performed by this change. Body size is independent of insert size. Capture, export and search/display limits are separate: display/search previews can be limited while complete original bytes remain retained and exported.
