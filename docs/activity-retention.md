# Activity retention

New activity is counted transactionally into local-hour totals, keyed by hour,
provider, account, model, client and source. The hour uses the event's UTC offset,
so fall-back hours have distinct epoch timestamps. Request retention deletes
request details, not totals, identities or checkpoints. Daily consumers aggregate
hourly rows by local calendar day.

On first open, `day_totals` is copied transactionally into `activity_totals` and
dropped. Existing rows remain whole-day baselines. Only new activity contributes
to hourly rows; baselines are never counted again from retained requests. Days
with both kinds sum disjoint usage. Legacy rows do not gain hour detail,
including when their requests still exist at upgrade time. Hourly charts omit
baselines; daily trends and range totals include them. Clearing Activity removes
both kinds.

New usage identities record their total's hour. Older identities belong to daily
baselines, so later client-log reconciliation subtracts legacy usage even when
new usage shares its hour and dimensions.

## Storage sample (2026-10-29)

A disposable copy of the encrypted database and WAL passed `integrity_check`.
The live database was never opened by the measurement. The database copy and
temporary decryption key were deleted afterwards. Policy blocked deleting the
temporary Electron profile; it contains copied Local State and Chromium caches.

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
