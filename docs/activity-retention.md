# Activity retention

New activity is counted transactionally into local-hour totals, keyed by hour,
provider, account, model, client and source. The hour uses the event's UTC offset,
so fall-back hours have distinct epoch timestamps. Request retention deletes
request details, not totals, identities or checkpoints. Daily consumers aggregate
hourly rows by local calendar day.

On first open, `day_totals` is copied transactionally into `activity_totals` and
dropped. In the same transaction, once (meta `retained-hours-rebuilt`), each day
whose stored requests account for every request in its totals is rebuilt as
hourly rows: requests, failures, all token counts and unpriced requests must match
exactly. Its recorded cost is kept by scaling the repriced hours, so price changes
since then don't alter history. Usage identities move to their hour, including identities not yet seeded.
Rebuilt identities retain their scaled cost so reconciliation subtracts what
was counted. New identities retain their original cost too; older, unreconstructed
identities without cost metadata still use current prices when reconciled.
A misplaced request rejects the entire filed day. Legacy imports normalize missing
client/source fields before generating keys. The rebuild scans requests once in
day order and parses only candidate days.

Residual: days already pruned, or whose stored requests don't match (a time-zone
change since recording), stay whole-day baselines. Hourly charts omit them; daily
trends and range totals include them. Days with both kinds sum disjoint usage.
Clearing Activity removes both kinds.

The retention cutoff is a local calendar date, and pruning deletes only rows
with `day < oldestKeptDay`. Every row filed on the cutoff day survives, including
both repeated hours on a fall-back day; pruning cannot split that day. A later
Earlier client-log imports could repopulate pruned days only partially, so the
migration proves completeness by comparing all usage counts and dimensions,
rather than treating the earliest surviving request date as proof.

Client-log imports delete expired request details in each batch transaction,
even after today's ordinary prune has run. Totals, identities and checkpoints
still commit; replay cannot resurrect expired details or count usage twice.

Usage identities store source, response ID, timestamp, provider and client in
columns only, rather than duplicating them in their accounting JSON. Existing
identities migrate transactionally. A one-time VACUUM enables incremental
auto-vacuum and compacts existing fragmentation. It runs in the activity worker,
so activity RPCs wait during migration while the main/UI thread remains available.
If VACUUM fails, the database stays usable, the failure is logged, and the
maintenance marker stays unset so the next launch retries.
Pruning and completed import batches then reclaim free pages incrementally.

Legacy matching applies to every provider. Eligible proxy identities have no
response ID or session ID and precede meta `first-matchable-proxy`; client-log
identities must be unmatched. Provider, model and all four token counts must
agree, with timestamps within `USAGE_MATCH_TOLERANCE_MS` (five minutes).
Only pairs with exactly one candidate on each side match. The client timestamp
may cross the boundary; only the proxy timestamp determines legacy eligibility.
Sessionful or response-ID proxy rows and post-boundary rows never use this rule.
Aggregate totals never establish a match.

Import batches judge ambiguity against all stored eligible identities after storing
the entire batch. A one-time transactional worker backfill (`legacy-usage-matched`)
selects all pairs before marking either side, keeps the proxy request and subtracts
the client's recorded accounting exactly once. Failure rolls back the marker and
accounting, leaves the database usable and retries next launch. An expression
index puts source, provider and token/model equality before the timestamp range;
coverage indexes alone would scan every identity in that provider's time window.

The October 31 disposable-copy audit for October 25–27 (local days) found
8,843 unique Claude matches among 10,027 eligible proxy identities, with zero
ambiguous matches (timestamp delta median 4.4 seconds, maximum 76 seconds).
Codex had zero unique matches among 1,250 eligible proxy identities, with 202
ambiguous proxy and 404 ambiguous client-log identities. Overall, 8,843 of 11,277
legacy proxy rows matched (78%), exceeding the overall 50% gate.
Residual: unmatched or ambiguous legacy rows, including Codex history, may still
double count in All usage.

The implementation verification on a fresh disposable copy reduced October 25–27
All-usage requests from 24,363 to 15,521 for Claude; Codex stayed at 1,742.
The whole-history backfill took 5.865 seconds, matching 8,971 Claude pairs
(including 8,843 proxy rows dated October 25–27). Re-running left totals unchanged;
`integrity_check` passed. The candidate query plan searched `usage_legacy_match`
by source, provider, signature and timestamp range.

Storage audit (2026-10-31, disposable encrypted snapshot):

- 159,983 client-log requests averaged 563.40 JSON bytes; 27,767 proxy requests
  averaged 503.62. Largest client-log strings: request ID 81.73 bytes, session
  ID 42.73, response ID 34.95; error and User-Agent were null.
- The ledger held 236,628 client-log and 27,361 proxy identities, averaging
  527.79 and 444.04 JSON bytes before compaction. Its table occupied
  261,603,328 bytes; request details occupied 128,978,944 bytes.
- Largest indexes: identity primary key 31,145,984 bytes, session match
  28,594,176, coverage indexes 16,379,904 and 16,363,520, response match
  15,642,624, request conversation 15,265,792.
- No requests preceded the October 2 retention cutoff. Free pages were
  1,379 of 132,010 (4,096 bytes/page): 5,648,384 bytes, so free pages alone
  did not explain the growth. Imported accounting history starts November 2025.
- VACUUM alone reduced 540,712,960 bytes to 502,423,552. Removing duplicate
  identity JSON fields and compacting reduced it to 449,925,120 bytes:
  109,845 pages, zero free pages, identity table 193,863,680 bytes.
- Compacted identity JSON averaged 384.55 bytes for client logs and 328.14
  for proxy rows. The resulting encrypted copy passed `integrity_check`.

The audit used copies of the database, WAL, secrets and Chromium Local State;
no live SQLite connection was opened. The copies were deleted after measurement.

Rebuilt requests receive explicit hourly ownership. Ledger seeding leaves other
requests attached to baselines, even if a matching hourly row exists.

Retained baseline identities remember the request's filed day, so a time-zone
change does not redirect reconciliation to another day. Residual: already-pruned
identities without a recorded day cannot recover their original time zone.

Identities still pointing at a baseline (`totalStart` null) make client-log
reconciliation subtract from that baseline, even when new usage shares its hour.

## Storage sample (2026-10-29)

A disposable copy of the encrypted database and WAL passed `integrity_check`.
The live database was never opened by the measurement. The database copy and
temporary decryption key were deleted afterwards. The temporary Electron
profile was deleted afterwards too.

- Sample: 154,739 retained requests, 30 active days (September 30â€“October 29).
- Hourly dimension rows: 965; median/day 17, max/day 163, mean/day 32.17.
- A table matching production occupied 544,768 bytes including its primary-key
  index (`dbstat`), or 564.53 bytes per row.
- Projected hourly totals: 1 year 6,632,550 bytes (6.33 MiB), 3 years
  19,897,651 bytes (18.98 MiB), 5 years 33,162,752 bytes (31.63 MiB).

Assumption: the mean active-day rate continues every calendar day (365.25 days
per year), with the same dimension lengths and page occupancy. Estimates cover
hourly totals and their index, excluding requests, usage identities, checkpoints,
WAL and legacy daily baselines. The sample includes the partial current day.
Already-pruned history has no hour detail and cannot contribute to measurement.

## Worker outages and quit

Proxy events have no cursor/replay contract. The fork creates a fresh subscriber
for each connection; its `resync` event reloads quota windows, not request history.
Pausing consumption would eventually overflow the proxy's 256-event buffer.

The RPC queue holds at most 4,000 pending calls (plus its final close command).
Only one call is sent to the worker at a time. An evicted in-flight event retains
one additional reference until its reply or worker termination.
Assumption: 2,000 events/hour is a planning rate, not a measured ceiling; this
covers two hours when only appends are queued. Other pending calls reduce that
coverage. Overflow drops the oldest unacknowledged append and rejects its promise;
the existing activity failure notice shows cumulative drops for this app session,
including during later import progress. An in-flight dropped event may already
have committed, so this count is a conservative loss count. Queries are rejected
when the queue is full and no append can be evicted. No plaintext spill is written.

Residual: overflow loses proxy details and totals for events not already committed.
Client-log imports can recover matching client usage, but cannot reconstruct all
proxy attempts. Before the worker change, a failed synchronous append was logged
and discarded immediately; the stream continued without retry.

One 25-second quit deadline covers proxy stop, stream draining, and queue close:
10 seconds for the management request, eight for proxy exit, and seven for stream
and SQLite flushing. At the deadline, retries stop, the reader is cancelled and
the worker is terminated. The log records the number of unacknowledged appends
still in memory; those not committed are lost. Crash/power loss can also lose the
memory queue. No queue survives a restart.

A proxy replay whose accounting identity survives retention but whose full
request identity no longer matches a retained row returns null. It cannot restore
pruned details, count usage twice, or return a row that reused the old numeric ID.
Every successful worker initialization emits a reset, exposing checkpointed imports
even when a previous scan committed and crashed before its final notification.
