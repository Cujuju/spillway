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
client-log import can repopulate an older, pruned day only partially, so the
migration proves completeness by comparing all usage counts and dimensions,
rather than treating the earliest surviving request date as proof.

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

- Sample: 154,739 retained requests, 30 active days (September 30–October 29).
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
