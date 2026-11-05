# Request archive (internal contract v1)

Implements the inspector portion of [#112](https://github.com/Cujuju/spillway/issues/112) and relates to #38. Capture is opt-in; client-log imports remain metadata-only.

The Activity worker alone owns `archive_entries`, `archive_attempts`, `archive_fts` (FTS5) and `archive_meta` in the existing encrypted `activity.db`. Encryption and key recovery follow `openActivityDb`; neither a plaintext body spool nor a separate database key is created. The renderer never opens the database. Future portable-export, diagnostic and trace features should use the worker API rather than opening a live database from another process.

## Identity and export-facing schema

Types are in `src/shared/archive.ts`. `ArchiveEntry.schemaVersion` is `1`. `id` is `trace:<full inbound trace ID>`, `traceId` is the exact desktop SSE `trace_id`, and nullable `captureId` is the proxy's capture UUID. `captureEpoch` and `captureSequence` preserve provenance after body expiry. Neither identity uses Activity's reusable SQLite row ID or short log filename IDs. One inbound exchange can have many upstream attempts; `ArchiveDetail.attempts` retains requestId/selectionId/at for up to 200 displayed attempts. These are execution identifiers, not alternate body lookup keys.

`ArchiveDetail` adds bounded `request`, `response`, `requestType`, `responseType`, `requestEncoding`, `responseEncoding` and attempt links. Bodies describe consumed downstream wire bytes, not upstream executor payloads. Empty or absent captures do not imply an empty model conversation. WebSocket frames are unavailable; the connection-level capture is partial after closure. Compressed or invalid UTF-8 data is explicitly partial and may be unreadable. No headers or query strings are captured. Body text can itself contain sensitive data; email masking applies to every renderer body and metadata field, but is not a general secret scrubber.

`model`, `provider`, `sessionId` and `client` are populated only from correlated Activity events. These dimensions are unknown if SSE metadata never arrived; they are never inferred from similar timestamps or short IDs. `model` preserves the requested alias. For an inbound exchange with multiple models, the latest correlated attempt supplies the summary dimensions; attempts retain their execution identity. A later trace view can join attempt IDs to its richer metadata.

## Worker and renderer API

- `archiveObserve(ActivityEvent)` records metadata for a real full trace; ignores client imports and absent trace IDs. The live worker's append path calls it, replay-safe.
- `archiveIngest(CapturePage)` validates a page and commits records, FTS and cursor in one transaction. Replay of a committed sequence is ignored. Failed pages leave the cursor unchanged.
- `archiveQuery(ArchiveQuery)` returns 50 metadata summaries newest first, plus `more`. Pass the last `id` as `before`. Filter by literal whitespace-separated keywords (AND), exact sessionId/provider/model/client/state, and inclusive from/to dates. Queries never return bodies.
- `archiveDetail(traceId)` returns one bounded record or null (unknown). No short-ID fallback.
- `archiveStatus()` returns policy, logical stored-body bytes, entry count, epoch, sequence, proxy drop counter, observed sequence gaps and epoch changes. Renderer IPC also supplies `syncError`.
- `archivePolicy(policy)` normalizes and persists captureBodies/retentionDays/maxBytes; main refreshes the proxy's operational lease.
- `archiveClear()` deletes bodies, index and identities. Renderer IPC first disables capture and clears the proxy spool. Clearing all Activity also clears archive data.

These APIs are the integration surface for future export/bundle/trace implementations. Existing data-transfer v1 exports Activity metadata only; it does not yet export this archive. Use `schemaVersion`, stable IDs, explicit state, provenance and bounded detail in any future format; never silently label missing captures complete.

## Policy and completeness

Default body policy is off, 7 days, 100 MiB. Allowed retention is 1–90 days and logical body budget 1–1024 MiB. Each downstream request and response retains at most 256 KiB of wire bytes (invalid UTF-8 can expand on conversion). Retention and oldest-first byte eviction remove bodies and FTS together, leaving `expired` identities. Budget counts serialized detail bytes, excluding SQLite/FTS overhead. Database file size can exceed the budget; encrypted free pages may persist until SQLite reuses or compacts them. Up to 20,000 metadata records survive, independent of Activity detail retention.

States: absent identity = `unknown`; metadata-only or known unavailable = `missing`; awaiting finalization = `pending`; bounded/unsupported/interrupted = `partial`; finalized observed HTTP exchange within limits = `complete`; body deleted by policy = `expired`. “Complete” does not certify upstream or semantic completeness. Pending metadata becomes missing after 10 minutes, but a later finalized capture can replace it. Turning capture off stops future collection and preserves existing archive bodies until expiry or deletion.

The main sync loop renews a 60-second proxy lease, reads at most four pages of four records per pass, and durably commits before advancing its cursor. It handles proxy epoch changes by restarting the cursor and marking pending records missing. The bounded in-memory proxy spool can lose data on overflow, crashes or disconnect. Drops, gaps and epoch changes are visible. A loss at the tail can appear only as a drop counter until another sequence arrives. Before first observation a proxy restart cannot be counted. No losslessness guarantee is made.

The inspector renders text safely through Solid, initially 32 KiB per body and incremental chunks in bounded scroll panes. Long-lived connections remain pending until finalization. Historical Activity and client-log imports without trace/capture data remain unknown. Capture is separate from existing request text-file logging; changing one does not enable or disable the other.
