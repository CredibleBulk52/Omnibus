# Shared metadata service

Maintained reference for metadata module boundaries and preservation contracts. The former phase-by-phase handoff is archived locally at `_backups/docs-archive/METADATA_PIPELINE_PLAN.md`; it is historical, is not distributed with a fresh clone, and does not establish current deployment status. Use the implementation and tests for current behavior. See the [documentation index](../../docs/README.md) for related guides.

## Module boundaries

| Responsibility | Modules |
| --- | --- |
| XML/filename evidence, supported CV identities | evidence.js, identity.js (`identity-v2`) |
| Conservative publication corroboration | candidate.js |
| Annual identification (annual volumes, year-named one-shots, crossovers; Claude among candidates) | annualIdentification.js |
| Provider mapping and preservation merge | cvSource.js, merge.js (`merge-v2`), dryRun.js |
| Shared first-tag/refresh plan | metadataService.js |
| Preservation-aware XML patch/readback | comicInfoPatch.js, xmlLayout.js |
| Bounded archive inspection/preparation | archiveValidation.js, archiveStaging.js, archivePreparationJob.js and shared archive tools |
| Durable ownership, publication, recovery | workJournal.js, archiveStorage.js |
| Same-book DB/index/provenance and acknowledged follow-ups | bookFinalization.js, bookFollowups.js |
| Scanner observations and reconciliation safeguards | scannerState.js, server.js and existing canon/list reconcilers |
| Cooperating application access coordination | libraryAccess.js |
| Existing-book and initial-arrival orchestration | reprocessingService.js |
| Existing CV/naming/application adapters and routes | retagRuntime.js, retagRoutes.js, server.js |
| Monitoring-independent durable work and lifecycle status | maintenance.js |
| Stored-observation report and narrowly scoped monitoring cleanup | reconciliation.js |

Inspect actual exports before extending a module; this table describes responsibilities, not an API contract.

## Contracts to preserve

Work identity is a stable physical book ID, not publication ID or monitored issue. Initial arrivals use the existing stableIds allocator during the journal finalization transaction. No second allocator; no cross-copy state updates. Existing progress, list membership, manual filing and links survive rename/conversion.

Download and embedded evidence are strong but contradictions hold. Folder/index/monitor/AI evidence only proposes candidates. Candidate matching requires coherent exact title/number/year and linked provider volume; ambiguous/truncated searches require explicit selection. Actual archive evidence is rechecked at execution. Explicit first tagging works; destructive corrections to existing identity still require a reviewed field plan.

Unknown useful values remain unowned and preserved. Source blanks never clear them; descriptive disagreements become observations. Proven managed fields may refresh only while current values equal previously applied values. Identity/publication-field conflicts hold. Date groups preserve source basis/precision; do not invent Day=1. Override inputs distinguish absent key from intentional blank, but persisted snapshots are not a new authoritative user-override editor.

XML patches retain unknown nodes, annotations, page metadata and existing Web/Notes text. First identity initialization adds the CV URL without creating duplicate Web scalar nodes. Successful archive work proves unchanged page bytes/order for metadata-only operations and reads back applied XML. Replacement with changed pages is a separate, unfinished contract.

Reuse existing unrar/7z/bsdtar and CBZ builder. Successful processed output is CBZ even for a scalar no-op on incoming CBR. Automatic work preserves basename/folder except required .cbz extension; explicit retag and downloads use existing canonical naming. Refuse occupied destinations. No existing book goes through download cleanup/placement.

## Execution and durable state

`reprocess` resolves an existing stable book; `arrive` handles an original download source and destination. Both use reserve/prepare/backup/publish/finalize/follow-up/retire/release. Initial arrival registration, managed provenance, index, applicable monitor path/status and journal receipt commit together. Finalized work recovers forward; pre-finalized recovery verifies original/backup fingerprints. Cleanup never discovers arbitrary library directories as targets.

Journal schema is version 5, with scratch, finalization and completion records. Managed ownership is in `metadata_book_managed`; finalization revisions and acknowledged cache/events/canon/reading-list work are durable. Follow-ups are awaited, idempotent and may repeat after lost acknowledgments. Successful scheduling of a future callback is not completion.

Cooperating access coordination serializes writers. Proven single-series writers fence readers of that series; broad writers and scans retain global scopes. This is not cross-process locking. Unfinished durable work and recovery admission are handled by the metadata runtime; inspect `libraryAccess.js`, `retagRuntime.js` and the admin route registrations in `../server.js`. Never infer worker quiescence from a lease or PID alone. Backups/unknown partial destinations remain held. Publication is a flushed copy and has no tested Linux power-loss guarantee.

`metadata_jobs` is keyed by book_id with observed file signature, first_seen, attempt/failure counts, publication date/basis/precision, library group and work kind. Migration is additive. Provider dates come from successful retag results, with stored ComicInfo dates as fallback. Daily checks within 90 days remain; dates over 31 days ahead hold. Unknown/older sparse checks and source absence are monthly, capped at three; transient failures hourly, capped at three; budget waits consume no attempts and stop the batch. Review waits for changed evidence/manual tagging. Successful manual no-ops also clear stale review and record provider date evidence.

Selection interleaves library/work-kind groups and persists last-served times in metadata_queue_groups. Live status joins scanned_books/scanned_series, excludes missing/orphan work and partitions lifecycle counts consistently. Identification is an overlapping subset. Existing panel uses new metadata-status/metadata-run endpoints, shows first 50 waiting entries and retains labeled historical sweep diagnostics. The status API accepts libraryId/offset.

Reconciliation reports stored observations, never current disk truth. clearDangling only clears references to absent monitored_issues in one atomic rechecking statement. It does not alter CV identities, stable IDs or user data. Explicit admin cleanup is behind library access admission. Parent/exclusive annual monitoring deletion clears its references in the same transaction; shared annual links remain. Identity differences require rescan/review; never bulk-assign from a stale snapshot.

Scanner/import enqueue outside matching; scheduled old sweep/rotation selectors invoke the common worker. Single downloads and matched pack members use `arrive`; pack outer extraction remains existing orchestration and preserves unresolved source. Manga arrivals now use the shared runtime/journal/converter with the existing manga filename helper. Numbered Volume and Manga reading direction use shared preservation rules; the legacy XML builder and extraction/copy branch were removed. Unmatched torrent files remain in place. Conservative v/vol/volume candidate parsing requires exact title/number/year support. The obsolete startup job deleting ComicInfo from suspected inserts was removed. Existing manual legacy selectors delegate archive writes to shared runtime. Check current route registrations before removing selectors; archived phase labels are not a current retirement checklist.

## Verification

Run the relevant `*.test.js` files with Node's test runner, plus `node --check backend/server.js` and syntax checks for changed production modules. Use disposable fixtures; do not start the production server for fixture verification.

Tests that use `node:sqlite` require a compatible Node runtime. Archive tests need their native tools; `OMNIBUS_TEST_7Z` can select the 7-Zip executable. Report unavailable tools as skips, not as passed coverage. A workstation test run is not equivalent to deployed Node/better-sqlite3/Linux-mount behavior or live provider responses.

Earlier phase reports, test totals and deployment notes are preserved in the local documentation archive and Git history. Do not quote their results as validation of a later change. Run the checks appropriate to that change and state what remains unverified.

## Provider lookup and responsiveness

Existing-book provider lookup runs outside the writer barrier. The runtime rechecks the book snapshot under exclusive admission before archive work; the service still validates physical identity/fingerprints. Single-tag and monitored retag entry points must not add an outer writer around provider fetches. Cancelled input is checked before lookup. Preparation and completion use the appropriate library access scope.

Maintenance network failures stop the current batch and persist a metadata-worker cooldown; untouched books keep their attempt counts. The panel displays that cooldown. Image pixel limits are classified as IMAGE_LIMIT after header inspection, without implying archive corruption. `eventYear.js` supplies consistent retention/assignment checks to avoid clear/rematch loops.
