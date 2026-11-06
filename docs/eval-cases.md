# Durable eval cases and explicit replay

Implements item 1 of [#112](https://github.com/Cujuju/spillway/issues/112). In Activity → Archive, select an interaction and use **Durable eval cases**. Supply annotations, expected outcome and literal assertions. Enable **Pin previously recorded protocol bodies** to retain available text; this never enables capture or reconstructs missing content. Saving annotations creates an immutable revision of the same snapshot.

Cases retain the integrated [`PortableCapture`](portable-archive.md): stable trace identity, capture state, bounded attempts with nullable provenance and original downstream protocol. Unknown, omitted, partial, expired and malformed states stay distinct. Complete describes the downstream capture boundary, not task completion. Messages/tools remain provider protocol content, not normalized training examples. Repository/revision labels and context notes are unverified declarations. The app never opens those paths, checks out repositories or executes imported text, tool descriptions or assertions.

## Storage and deletion

The Activity worker exclusively owns `eval_cases` in encrypted `activity.db` through existing RPC. No second database reader is introduced. A case has a `case:<UUID>` identity, numbered revision, parent revision, creation time, annotation, portable capture, provenance, missing-context list and `taskOutcome: unknown`. Local create/revise RPC operations have stable operation IDs for worker retries.

All cases are pinned. Ordinary Activity retention, archive body expiry and **Delete archive and turn capture off** preserve cases/revisions. There is no automatic eviction or unpin operation. Limits: 200 identities, 8 revisions per identity, 4 MiB serialized snapshot, 8 MiB per identity across revisions, 64 MiB total serialized cases. Additions exceeding a limit fail atomically and require explicit deletion. SQLite indexes/page allocation and reusable free pages add filesystem overhead.

**Delete case and ALL its revisions** removes the identity. Settings → **Clear activity history** deletes the archive and every case/revision; its confirmation names this consequence. Case deletion invalidates matching replay previews/results, cancels execution and invalidates pending eval exports. Whole Activity deletion cancels all eval operations, blocks preparations during deletion and invalidates preparations awaiting the worker. Late completion cannot restore deleted cases or accessible results. Completed external export files remain user-owned copies. Atomic rename is the export commit point.

Encrypted accounting transfer (`--data-export`, `--data-import`, `SPILLWAY_TRANSFER_KEY`) stays unchanged and does not transfer cases. Use portable case export.

## Portable files and untrusted import

**Prepare export for review** freezes one saved revision. Bodies default to omitted. Explicit inclusion exports retained content only. Preview displays exact file text without screen email masking. A native dialog saves those bytes through an exclusive temporary sibling, flush/close and atomic rename. Preview expires after five minutes and is consumed when an accepted save begins; changed annotations/options need a new preview. Replacement/discard/deletion invalidates previews. Failed writes remove partial files or surface cleanup failure.

Files are plaintext and may contain sensitive annotations, metadata and prompt prose. Auth/config files and replay results are excluded. Export redacts common credential patterns/secret field names and exact current app/proxy client, management and database credentials in main; credentials never go to the Activity worker. Arbitrary secrets in prose or opaque content cannot all be recognized: review the frozen file and omit private bodies.

Redaction can alter requests, responses and assertions. Export recomputes nested `payload.sha256` over transformed `JSON.stringify(payload.data)` and the exact-byte whole-file trailer. `portability` records `policy: credential-redaction-v1`, protocol included/redacted/omitted, original payload digest when available and `replayFidelity: not-guaranteed`. Earlier redaction disclosure survives re-export. Altered content is never presented as byte-faithful original replay. Representation stays `downstream-protocol-v1`; no normalized messages are asserted.

Case JSONL v1 is UTF-8 without BOM, with one JSON object per exactly LF-terminated line:

1. Manifest: `type: manifest`, `format: spillway.eval-cases`, `version: 1`, `records`, `taskOutcome: unknown`.
2. That many `type: eval-case`, `schemaVersion: 1` records embedding the integrated portable capture contract.
3. Trailer: `type: complete`, matching `records`, `bytesBeforeTrailer`, lowercase SHA-256 of exact preceding UTF-8 bytes including every LF. EOF follows its LF.

Native import also accepts integrated `spillway.request-archive` JSONL v1. It verifies UTF-8, versions, counts, exact-byte trailer integrity, nested payload hashes, identities/duplicates, literal assertions, metadata/payload structure and limits before an atomic database transaction. Bounds: 64 MiB file, 4 MiB per line, 200 records (narrower than general archive export). Enumeration is bounded before JSON parsing. Unsupported versions, malformed data, identity conflicts or quota overflow reject the entire import. Existing revisions cannot be overwritten. Identical imports are idempotent; archive imports derive identity from file digest + capture identity. Unknown record fields survive forwarding subject to redaction, and never authorize execution.

Exports contain one revision; its parent may be unavailable on a new destination. For an existing identity, new imported revisions must immediately follow the local latest revision and retain exactly the same portable capture and archive identity. Family rows within one file are checked in revision order. Changed captures or gaps reject the entire import. Importing an altered/redacted export over the same existing identity/revision fails with an immutable-snapshot conflict.

Every imported case is marked `portable-import`, regardless of producer claims; its prior origin claim or the verified file digest is retained in `importedFrom`. Integrity hashes do not authenticate producer/provenance. Imported content without transformation metadata is explicitly labeled as having unverified transformation history before execution. Import does not populate Activity/accounting or the live capture archive. Imported archive captures initially lack assertions and need an annotated revision before replay.

## Working replay path

**Preview supported model-call replay** performs no provider call. The separate **Run this model call now (uses provider quota)** action starts execution. Preview binds one immutable case revision, criteria, request, model, fixed route, current loopback proxy root endpoint and current client credential fingerprint. It expires after five minutes and can start once. Changed destination/auth requires a new preview. Captured/imported URLs, headers and credentials never become execution destinations/auth. Redirects are rejected. No client setup, native Codex provider/login, Claude Code headers or production config is changed.

| Captured protocol | Replay support |
| --- | --- |
| `POST /v1/chat/completions` | Complete HTTP JSON capture, self-contained string content on system/user/assistant messages. |
| `POST /v1/messages` | Complete HTTP JSON capture, self-contained user/assistant text strings/blocks and optional text system context. |
| Responses, native Codex, WebSocket, other routes | Inspectable snapshots; replay unsupported. |
| Tools/calls/results, attachments/images/URLs, previous-response state, unknown extensions, opaque encoding, incomplete/omitted content | Inspectable snapshots; replay unsupported with a reason. Captured tools never authorize tool execution. |
| Full agent task | Unsupported: no appropriate harness, verified repository checkout/revision, dependencies, tool permissions or reproducible workspace state is supplied. |

Recognized request fields: model, messages, stream, max_tokens, temperature, top_p, and Anthropic system text. Unknown fields are rejected. Supported sampling/text context is retained; streaming is disabled and output tokens capped at 2,048 (512 when absent). This reconstructs a model call; byte-faithful original replay is not promised. Export transformation/fidelity disclosures appear before execution. Current proxy accounts/routing can differ from capture time. Preview exposes request context, model, route, destination, environment and limits.

Execution bounds: 60 seconds, 256 KiB response bytes, 64 KiB extracted output, one active operation and one transient in-memory result. Cancellation aborts fetch/reading. Deadline, transport/HTTP errors, malformed/provider-error JSON, unexpected streaming, tools, output limits or incomplete/truncated terminal states fail with `comparison: not-evaluated`. HTTP 200 alone never passes. OpenAI needs one text choice with `finish_reason: stop`; Anthropic needs text content with `stop_reason: end_turn` or `stop_sequence`. No output is executed. Results are not appended to cases or exported.

At least one saved assertion is required. `contains`, `not-contains` and `equals` compare literal, case-sensitive extracted output. Every assertion must pass. No regex, scripts, shell, automatic judge or filesystem checks run. Expected-outcome prose remains for human review. Even passing criteria leave `taskOutcome: unknown`; canceled/failed partial output never passes.

Renderer APIs in `src/shared/ipc.ts`: `evalList/Get/Create/Revise/Delete`, native-dialog `evalImport`, `evalExportPrepare/Save/Discard`, `evalReplayPrepare/Start/Status/Cancel`. All persistence/import reading run in the Activity worker. Frozen reviewed export output and bounded HTTP execution run in main. Results include case/revision, HTTP status separately from criteria, individual assertion checks and unknown task outcome. Tests use synthetic clients and isolated databases/files, never real providers, tool execution or user repositories.
