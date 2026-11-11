# Issue summary pipeline

Current integration reference, reviewed against the source on October 26, 2026. External summary import is implemented; the October 19 proposal and installation-specific inventory are archived locally under `_backups/docs-archive/markdown-cleanup-2026-10-26/docs/` and remain in Git history.

## Writing summaries

Use [ASTRA_SUMMARY_INSTRUCTIONS.md](ASTRA_SUMMARY_INSTRUCTIONS.md) for the page-reading workflow and schema-1 JSONL record format. Its host paths describe the owner's installation; other installations must substitute their own paths. Do not modify source comic archives while generating summaries.

Each run writes a separate JSONL file into `<COMICS_PATH>/_summaries_outputs` as seen by the server. Keep page evidence, uncertainties and separate stories in the record rather than inventing missing details. The writing instructions remain unchanged by this documentation cleanup.

## Importing records

[importSummaries.js](../backend/recaps/importSummaries.js) validates records and matches them by Comic Vine issue ID, archive path or filename. It stores imported summaries in `issue_synopses` with source `import`, retaining the full record in notes.

| Record status | Import behavior |
| --- | --- |
| `ok` | Stored and trusted; not replaced by an ordinary web lookup |
| `partial` | Stored, but page reading may still be needed when used for a recap |
| `unreadable` | Not stored as a usable synopsis; reported for retry |

[recaps/index.js](../backend/recaps/index.js) wires the importer, schedules a check shortly after startup and hourly thereafter, and exposes admin-only GET/POST `/api/admin/recaps/import`. POST accepts `dryRun` and `force`; GET reports stored import information. Setting `OMNIBUS_NO_SUMMARY_IMPORT` to a nonempty value disables scheduled checks; it does not remove the manual admin routes. A missing input folder causes no import work.

Unchanged files are normally skipped using their size and modification time. `force` reprocesses files but does not bypass record-level newer/better-summary safeguards; `dryRun` reports results without storing summaries or import history. A partial record does not replace an existing complete imported or page-read summary.

Keep whole-issue synopses compact because they are passed into recap prompts. Preserve scene detail, separate backup stories, characters, key events and uncertainties in the structured record; `scope.storedNotes` also uses imported characters and key events when finding relevant story notes. Summaries must cover only their own issue.

Use [importSummaries.test.js](../backend/recaps/importSummaries.test.js) and the implementation for exact validation, conflict and matching rules. Do not use the archived proposal as the API contract.

## Reading and recap consumers

- [synopses.js](../backend/recaps/synopses.js): stored summaries, fallback lookup and page reading.
- [scope.js](../backend/recaps/scope.js): reading position, spoiler boundary and recap material.
- [arcs.js](../backend/recaps/arcs.js): story-arc and stretch summaries.
- [assistant.js](../backend/assistant.js): reader-facing story and recap tools.
- [AI_MODELS.md](AI_MODELS.md): task routing and provider integration.
- [synopsis-control](synopsis-control/README.md): preserved issue-specific quality references, not runtime prompts.

Preserve provenance, incomplete/unreadable status and the spoiler boundary when changing this pipeline. Benchmark costs and library counts from old notes are historical observations, not current guarantees.
