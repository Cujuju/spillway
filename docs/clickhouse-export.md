# Optional ClickHouse event destination (schema v1)

Settings → Data → ClickHouse exports immutable archive facts. Export and content inclusion are independently opt-in. Configure an HTTP(S) origin, database and `tablePrefix` (default `spillway`). Check and Create table handle both `<prefix>_facts` and `<prefix>_pieces`. Prefixes are simple SQL identifiers limited to 56 characters so the longest suffix fits the 63-character identifier limit.

Credentials remain in `secrets.bin` and are sent only in ClickHouse authentication headers. Redirects are rejected. Diagnostics hide server responses. Changing destinations requires an empty queue and pauses delivery. Local unreleased v2 state, outbox and triggers are dropped once with no migration; remote v2 tables are left alone. A fresh local source identity is created.

## Facts and content references

`attempt`, `capture`, `finalized` and backfill `snapshot` facts are appended transactionally with archive writes. The encrypted outbox stores metadata and immutable revision range references, never another body copy. Its 1 GiB budget counts metadata and references and drops oldest facts when full. Facts have monotonically increasing sequence IDs. Enabling export or content, or changing destination, backfills retained entries in `(at,id)` order. Clear queue stops backfill; archive clear also clears the queue. Neither retracts remote data.

Request pieces are sent on demand, before the facts referencing them. Preparation includes each unsent request piece once per batch. After both INSERTs succeed, acknowledgment marks delivered request pieces sent and deletes acknowledged facts. A destination change resets all sent flags. This resync rule covers dropped or cleared queue rows and backfill without special handling: a piece remains unsent until delivery is acknowledged. Superseded revisions can reference earlier immutable pieces.

Thread eviction clears content references on queued facts and increments `contentExpired`; the facts remain queued with `content_policy='source-expired'`. Metadata-cap deletion does not remove pieces. Policies are `included`, `metadata-only`, `source-unavailable` (capture disabled or absent source), `omitted-size-limit`, and `source-expired`. A backfill snapshot of an entry whose text expired before it was queued sends `source-unavailable` with `capture_state='expired'`; `contentExpired` counts only content lost while queued.

`record_json` is metadata only. Included requests use `request_pieces`; responses and structured frames use `response` and `frames_json`. Exported content is original data, independent of UI email masking. Local body retention applies to unsent content too; queue rows cannot preserve expired bodies.

## Remote schema

```sql
CREATE TABLE IF NOT EXISTS default.spillway_facts (
 schema_version UInt16,
 source_id String,
 source_label LowCardinality(String),
 seq UInt64,
 kind LowCardinality(String),
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

Checks require exact columns and types, no defaults, these sorting/partition keys, and an unversioned ReplacingMergeTree-family engine. Shared and Replicated variants accept quoted coordination arguments. `schema_version` is 1. Piece sequence IDs are immutable local piece IDs and never reused. Source identity survives clears; replacing the database changes it. Source labels are applied at preparation time.

## Delivery and reconstruction

Batches include at most 1,000 total piece and fact rows and 8 MiB of uncompressed JSONEachRow lines across both tables. Oversized content is omitted, while oversized metadata is discarded and counted. Pieces INSERT first, facts second, each compressed with `Content-Encoding: zstd`. Both use `async_insert=1`, `wait_for_async_insert=1`, and `wait_end_of_query=1`. Acknowledgment follows both complete empty responses. Failure or uncertain delivery retains the queue and sent flags for retry. Inserts add one second per 32 KiB to the 15-second diagnostic timeout; retries use exponential backoff capped at five minutes with equal jitter. Successful delivery drains immediately.

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
