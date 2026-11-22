# Convert historical ClickHouse captures

The Spillway history tool can convert eligible v3 Base64 capture chunks to v4 raw bytes in a pair of shadow tables. It leaves the source pair untouched. It preserves v2 facts, capture boundaries, empty WebSocket markers, and any Base64 piece still referenced by an unchanged fact. It doesn't change Spillway's raw export setting.

## Collect replay floors

Choose a maintenance window. Stop every Spillway writer to the destination, including any replicas of a profile. Wait for in-flight uploads, then flush the ClickHouse async insert queues for the two source tables on every node that accepts writes. Keep the writers stopped through the final verification and cutover. A [ClickHouse admin can flush the queues](https://clickhouse.com/docs/reference/statements/system#system-flush-async-insert-queue).

With Spillway fully quit, run the installed app once on each profile that can write to this destination:

```text
Spillway --clickhouse-replay-floor=<absolute path to a new report file>
```

The command exits after writing a JSON object with `version`, `sourceId`, and `firstReplayablePieceSeq`. It reads a temporary copy of the profile's encrypted activity database and WAL. Allow space for that copy. Finish any pending activity storage move first. The report is specific to that database generation and omits credentials and capture content.

Pass all applicable reports using repeated `--floor-report` flags. For a source with multiple replay-capable copies, the lowest reported floor applies. A source without a qualifying report stays unchanged. Use `--retired-source <source-id>` only if you can attest that the source will never write or be restored to this destination. The plan prints those attestations in `retiredSources`.

The tool converts only v3 chunks whose piece sequence is strictly less than `firstReplayablePieceSeq`. It removes the Base64 piece from the shadow only if no unchanged fact references it. Keep backups that predate the floor out of the destination. If you restore one, either send to a fresh destination or reconcile its replayable pieces and resync uploads before rejoining. Pausing export or toggling raw export leaves the saved sent flags in place.

## Build and verify shadows

Run from the Spillway checkout with Node 24. Use `SPILLWAY_CLICKHOUSE_USERNAME` and `SPILLWAY_CLICKHOUSE_PASSWORD` for authentication. The example uses a local scratch server. Use the destination's database and table prefix.

```sh
node scripts/clickhouse-history.mts --endpoint http://127.0.0.1:8123 --database default --prefix spillway --floor-report /absolute/path/replay.json
```

This command runs SELECTs and reports converted facts, new raw pieces and reclaimable Base64 pieces as counts. A run against an active destination gives an estimate. Use the fenced run for the final counts.

Automatic shadow builds require schema v2 tables with plain, unversioned `ReplacingMergeTree` engines in an `Atomic` database. Run Check in Spillway and complete Upgrade tables first if the facts table lacks `record_key`. Allow room for the shadow copy alongside the source. Pick a new prefix and keep it unused by other writers.

```sh
node scripts/clickhouse-history.mts --endpoint http://127.0.0.1:8123 --database default --prefix spillway --floor-report /absolute/path/replay.json --shadow-prefix spillway_v4_shadow --fenced
```

The tool clones each table's DDL, including its codecs, sorting key and partition key. It accepts identical retries and stops on conflicting duplicates, missing pieces, invalid chunk extents, or a conflict with an existing raw piece. It compares every shadow row against the expected result using the same `FINAL` settings on both sides. Check for `"shadowBuilt":true`; when no chunks qualify it returns `false` and creates no tables. A failed build can leave incomplete shadows. Inspect them or choose another unused prefix before retrying.

For Replicated or Shared engines, run the read-only plan and rehearse on a consistent backup restored into an isolated plain `ReplacingMergeTree` destination. To carry the conversion back, have the operator provision independent shadow tables under the deployment's supported replication and cutover process. Verify the staged rows against the rehearsal. Use distinct coordination paths or UUIDs and check how the deployment resolves table and database macros on rename. [ClickHouse replication documentation](https://clickhouse.com/docs/reference/engines/table-engines/mergetree-family/replication) covers those engine constraints.

## Cut over and retain a rollback copy

Run the [capture reconstruction and terminal queries](clickhouse-export.md#delivery-and-reconstruction) on both prefixes before cutover. Compare request and response byte counts, SHA-256 hashes, and frame boundaries on representative HTTP and WebSocket captures. Keep the partial state for any incomplete capture.

Pause readers before the first swap. Keep readers and writers stopped until both swaps and the checks are complete. Run each [EXCHANGE TABLES](https://clickhouse.com/docs/reference/statements/exchange) separately and record which succeeded:

```sql
EXCHANGE TABLES default.spillway_pieces AND default.spillway_v4_shadow_pieces;
EXCHANGE TABLES default.spillway_facts AND default.spillway_v4_shadow_facts;
```

If a swap or verification fails, check the table identities and reverse only the completed swaps in reverse order. Verify the pair under the original names before resuming readers or writers. After a successful swap, check the schema and reconstruct captures under the live prefix before resuming.

Keep the original pair under the shadow prefix for rollback. Reclaiming its disk space requires a separate operator decision. After writers resume, reconcile writes made after the swap before rolling back so the newer facts and pieces survive.
