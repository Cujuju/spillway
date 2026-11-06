# Optional ClickHouse archive destination (schema v1)

Implements item 2 of [#112](https://github.com/Cujuju/spillway/issues/112), `arc/request-observability`. Local encrypted SQLite remains authoritative. Export is off by default, does not deploy ClickHouse, and makes no network requests until a saved destination is enabled or the user explicitly checks/creates its table.

## Setup and privacy

Settings → Data → ClickHouse accepts an HTTP(S) **origin** (no userinfo, path, query or fragment), an existing database, and a table. Database/table names must match `[A-Za-z_][A-Za-z0-9_]{0,62}`. Save first, then Check for a read-only connection/schema diagnostic, or Create table to create the table below in the existing database. Automatic delivery verifies schema compatibility once per destination (origin/database/table), reusing verification until a delivery error, stop/start, or explicit Check/Create. It never creates a database/table automatically. An incompatible engine/sort-key alteration that causes no insert errors is detected only after the next failure, Save, Retry, or restart (or explicit Check/Create). Check does not certify INSERT permission; delivery tests that permission.

Username/password enter through write-only IPC and use the existing `secrets.bin` mechanism (including its existing OS-encryption availability fallback). They never return to the renderer/status, enter query strings, or appear in diagnostics. They are sent only in `X-ClickHouse-User`/`X-ClickHouse-Key` headers to the configured origin; redirects are rejected and normal TLS certificate validation is enabled. HTTPS protects them in transit. Header credentials must use Latin-1 characters without control characters; unsupported input is rejected explicitly. Blank credential inputs keep credentials bound to the current endpoint; Forget credentials deletes them. Without matching saved credentials, the destination uses user `default` with an empty password.

A destination change first commits the new destination **disabled**, after a worker-atomic backlog check. Only then are credentials cleared/replaced, and the requested enabled state applied. A failing backlog check preserves the old destination and credentials. A crash or secrets-write failure during this transition leaves the new target disabled; stored credentials are bound to their origin and cannot be sent to a different endpoint on restart. Re-enabling after such a failure requires an explicit Save.

Metadata-only is the default. Upload content requires **both** Include captured content and the archive's current captureBodies policy, plus available retained bytes. The exporter never reads client-log prompts or fetches provider-hidden content. `capture_state` preserves pending/partial/missing/expired/complete; it never treats absent content as complete or HTTP 200 as task success. Email display masking applies to renderer diagnostics; exported records are the original archive data, not the UI's masked presentation. Metadata (including session identifiers) can itself be sensitive.

## Versioned remote schema

```sql
CREATE TABLE default.spillway_archive_v1 (
    schema_version UInt16,
    source_id String,
    id String,
    revision UInt64,
    trace_id String,
    at String,
    capture_state String,
    content_policy String,
    record_json String
) ENGINE = ReplacingMergeTree(revision)
ORDER BY (source_id, id);
```

The existing database must be writable by the configured user. Schema validation requires these exact columns/types, no column default expressions, a ReplacingMergeTree-family engine with `revision` as its version, this sorting key, and no partition key. Plain, Shared and Replicated variants are accepted, with optional quoted coordination path/replica arguments. [ClickHouse Cloud uses SharedMergeTree-family equivalents](https://clickhouse.com/docs/products/cloud/features/infrastructure/shared-merge-tree); tests simulate their schema responses without contacting a Cloud instance. `schema_version=1` versions the export envelope; `record_json.schemaVersion=1` identifies the archive contract. UTC archive timestamps remain ISO strings to preserve original precision. No upstream accounting totals are generated or modified.

`source_id` is generated once in the encrypted Activity database and survives archive/queue clears. `id` remains `trace:<full trace ID>` and `trace_id` remains the full inbound trace. A database replacement creates a new source identity. `revision` is a durable monotonic SQLite sequence independent of Activity row IDs, capture sequence resets, and wall clock changes. Actual archive metadata/body/attempt changes and export/capture policy changes produce newer revisions. Live WS pending snapshots therefore cannot suppress later final revisions. Replaying an already ingested capture sequence does not produce a revision.

`record_json` contains the archive entry and attempt links; when eligible it contains the full bounded archive detail including decoded flags, format and structured frames. Attempt objects are copied intact, preserving optional provenance fields supplied by archive peers. Nullable/unknown fields remain unknown. Metadata-only records omit request/response text, frame payloads, content labels and decoded flags; entry `bytes` still describes source storage, not uploaded content size. `content_policy` is `metadata-only`, `source-unavailable`, `included`, or `omitted-size-limit`. If a single content record exceeds 8 MiB serialized, it falls back explicitly to metadata. Source capture limits and support boundaries are described in [request-archive.md](request-archive.md).

## Delivery and recovery

The existing Activity worker exclusively owns `clickhouse_state`, `clickhouse_queue`, and `clickhouse_batch` in its encrypted database. No second process opens that live database. SQLite triggers record changes transactionally with archive mutations. Ordinary writes only update bounded local references; all HTTP waits run asynchronously in the main process, outside the Activity worker's RPC queue.

The queue coalesces unsent revisions by stable identity. It holds at most 20,000 references, discarding oldest revisions on overflow and reporting the count. One durable encrypted batch freezes at most 1,000 records / 8 MiB. Oversized content falls back to metadata; an oversized metadata record is skipped and counted in both discarded and oversized, so it cannot stall later records. Successful full acknowledgment deletes only matching queued revisions; updates made during an upload remain queued. There is no plaintext spool. Queue counters report revision deliveries and explicit discards, not requests, token usage or semantic task completion.

Frozen batches carry a destination fingerprint (origin/database/table) included in their batch token. Acknowledgment must match the batch token, fingerprint and current destination. Main-process reconfiguration serializes changes, cancels the previous request and awaits its run before saving credentials/configuration. Cancellation generations prevent an older operation from restarting delivery after a later Cancel. A prior-target completion therefore cannot acknowledge replacement backlog or redirect its frozen payload.

Each HTTP POST puts SQL and JSONEachRow data in the body, sets `wait_end_of_query=1`, and uses `async_insert=1, wait_for_async_insert=1` so ClickHouse can merge inserts from many installs while responding only after data flushes to the table. The entire bounded response must finish successfully; nonempty insert responses, exception headers, HTTP failures and interrupted responses retain the batch. Diagnostics time out after 15 seconds. Inserts add one second per 32 KiB of submitted SQL/data (about 4.5 minutes for a full batch), allowing slower uplinks without an unbounded operation. A slower connection can still time out; cancellation remains available throughout. Credentials, response bodies and captured SQL/data are never included in error messages. [Official HTTP acknowledgment/buffering documentation](https://clickhouse.com/docs/concepts/features/interfaces/http) explains why an HTTP success code alone is insufficient.

Failures persist the batch, attempt count, generic failure and next attempt time. The exponential backoff upper bound starts at one second and doubles to five minutes; equal jitter chooses a delay between half and all of that bound to spread retries across installs. After acknowledgment, delivery runs again immediately to drain backlog. Idle, skipped, failed and backoff-blocked runs wait three seconds before checking again; idle installs send no HTTP requests. The same frozen bytes, stable identities and revisions retry after a timeout, crash, outage or partial write. There is no per-row acknowledgment assumption: the whole uncertain batch retries. Retry / resume removes the delay. Invalid credentials and incompatible/missing schemas remain visible failures with bounded retries; local Activity writes continue.

Delivery is **at least once physically, with latest-revision logical deduplication**, not exactly once. Always query with `FINAL` (or equivalent explicit latest-version aggregation) before counting requests or usage:

```sql
SELECT capture_state, count()
FROM default.spillway_archive_v1 FINAL
GROUP BY capture_state;
```

Retries can leave physical duplicate rows and superseded snapshots. [ReplacingMergeTree documentation](https://clickhouse.com/docs/reference/engines/table-engines/mergetree-family/replacingmergetree#query-time-de-duplication--final) requires query-time deduplication for correct results. This design does not depend on a server block-deduplication window or treat `query_id` as an idempotency key: [official retry-deduplication documentation](https://clickhouse.com/docs/concepts/features/operations/insert/deduplicating-inserts-on-retries) describes finite-window limits and uncertain insert outcomes. Downstream materialized views that sum raw physical inserts can inflate usage and are outside this contract.

## Disable, clear, retention and cancellation

Disabling stops new queueing and pauses delivery, preserving existing references and the frozen batch across restart. The default-off observation path does not rewrite exporter state or scan its backlog. Re-enabling backfills currently retained archive identities with newer revisions. Changing Include captured content invalidates the frozen batch; enabling export or changing that policy while enabled queues retained entries under the new policy. When content export is selected, changing the archive's captureBodies flag also invalidates the frozen batch and revises all retained entries with body bytes, including acknowledged ones. Identical/retention-only policy saves do not force re-upload; actual expiry/budget eviction queues the affected revisions independently. A metadata-only newer version does not securely erase earlier content on the server.

Clear queue cancels delivery and discards unsent references/batches without deleting the local archive or remote data. New source revisions can queue immediately when enabled. Re-enabling later can queue the retained archive again. Changing destination is rejected while backlog remains, preventing silent redirection; clear it first. A new destination receives currently retained identities. Manual/overflow discard counters persist; source retention deletion is not counted as a delivery failure.

References do not pin captures. Source expiry/budget eviction removes queued content and invalidates any frozen batch containing it; the latest metadata then reports `expired`. Deleting an archive identity removes its reference and invalidates affected batches. Clearing the archive or Activity removes queued references/batches together with source rows; the replay cursor remains governed by the archive contract. There is no pin API in archive v1; retaining/pinning a capture in a future peer does not grant upload-content permission, extend exporter storage limits, or bypass source policy.

Cancel pauses this process until Retry / resume, Save, or restart, preserving queued work. Shutdown cancels HTTP before Activity drains. A connection abort cannot recall data the server already received. Clear, expiry, body opt-out and cancellation stop future eligible sends but **never retract remote copies**, and an in-flight request can still commit. Durable retry identity makes subsequent recovery logically duplicate-safe. Backlog, bytes, oldest queued revision, acknowledgments, discards, retry delay and latest generic error are visible in settings.

## Synthetic demo and verification

`pnpm demo -- --clickhouse` starts a separate loopback fake HTTP destination alongside the existing isolated fake proxy/profile. Its printed endpoint can be entered in Settings → Data → ClickHouse; Check/Create and delivery use synthetic data only. Body capture can be enabled independently in the Request archive. The fake is not a database deployment and persists nothing after the demo exits. `scripts/demo/clickhouse.mts` exposes deterministic credentials/schema/partial-write/disconnect/delay fixtures for `src/main/clickhouse.test.ts`.

Trigger definitions are refreshed transactionally whenever the Activity database opens, so fixes apply to existing queues without dropping their data. Tests cover default-off metadata privacy and write overhead, both content opt-ins, evolving WS revisions, replay, encrypted restart, backoff, retention/clear, queue/batch bounds, credential/header handling, destination staging failures, durable credential binding, pause persistence, schema and HTTP 200 errors, partial writes, disconnects, cancellation and an unreachable destination. No production app, proxy, config, auth or real ClickHouse server is used.
