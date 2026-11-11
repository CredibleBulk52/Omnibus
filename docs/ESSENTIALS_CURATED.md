# Essentials curated catalog

2026-11-07: Essentials keeps its masthead and spotlight, and defaults to scrollable collection rows (roughly four journeys visible on desktop). View all opens a complete collection; All Essentials opens the complete catalog. Search, publisher, sort, collection and view are URL parameters so returning from a journey preserves the selected view. All curated rows use the shared ShelfScroller arrows, touch/trackpad scrolling and keyboard controls. All members are available within each row. Search applies to the full catalog, not only preview cards.

Collections are selected in the existing list editor Details panel and Organize dialog using the same component. Add an existing name or create one inline. Multiple memberships are supported. Publisher/library associations and spotlight selection remain separate.

Storage: optional catalog_json.collections string array (20 names maximum, 60 characters each, case-insensitive deduplication). Missing array falls back to existing by_publisher/group placement. Empty array explicitly means More journeys. No schema migration or destructive conversion. Existing section title keys are retained; DC/Marvel and legacy publisher headings keep publisher keys, custom collections use group:<lowercase name>. Existing readers/lists retain their prior catalog view.

Verification: frontend production build; backend readingListCatalog.test.js; actual Essentials component rendered with fixture data at 1440, 820 and 390px, including collection View all, complete catalog, search, Organize input and overflow checks. Live cover art and deployed app still require a user review.

Backup: _backups/code/essentials-curated. No deployment performed.

Collection headers reuse PublisherLogo uploads. An explicit publisher prefix (for example DC: Heroes journey) supplies default publisher branding. Edit header lets admins choose Automatic, None, or a publisher, and override the bar/accent colors. These overrides live beside existing titles in catalog_publisher_notes.essentials_styles, keyed by stable collection key. Reset appearance restores inherited styling; memberships and publisher filters are unaffected.

The Essentials main-content container permits document scrolling so its sticky filter stays below the top bar, including the 46px phone header. Verified using the app wrapper at desktop, tablet and phone widths.


## Managed collections

Essentials collections now have stable IDs in `essential_collections`. On startup, existing Essential memberships (including legacy publisher/group assignments) migrate to those IDs. Existing section titles and color overrides are imported from `catalog_publisher_notes`; reading-list sections retain their existing settings. The migration is repeatable and does not change reading progress or list ownership.

Admins create a collection from **New collection** on Essentials. **Edit collection** changes its name, publisher/character branding, optional color overrides, and the ordered journeys shown first. The list editor selects existing collections from a dropdown; multiple memberships remain supported. Row arrows beside the edit action change the saved collection order. Unpinned journeys follow A–Z. Empty collections appear only for admins in the unfiltered catalog.

Site branding follows Appearance colors. Character/team branding reuses `readingPalettes`, `paletteTokens`, and `CharacterSymbol`; publisher branding reuses `PublisherLogo` and existing publisher colors. Manual colors override that choice. Large theme motifs are not repeated in row headers.

The spotlight keeps its description with an opening bold passage separated visually. Essential cards omit the redundant visibility label. Scroll navigation and View all appear only when a row overflows; the horizontal scrollbar uses a subdued theme accent until hovered.

API: authenticated GET `/api/essential-collections`; admin POST at the same path creates/edits a record. Admin POST `/api/essential-collections/order` requires the complete unique ID order. Existing list APIs expose resolved collection names plus `collection_ids`. Back up the application database before deployment as usual; pre-change source copies are in `_backups/code/essentials-registry`.


Collection deletion is available in Edit collection (admin only). It removes memberships transactionally and preserves all reading orders; empty membership arrays prevent legacy groups from recreating the deleted collection on restart. The grouped tab is labeled **Featured shelves**. Essentials, Timeline events and Top Shelf runs expose confirmed deletion in Manage for admins; owners can delete personal reading orders there. Comic files and reading progress are not deleted.


## Editing collection membership

The browse switch is **Collections / All Essentials**. The quieter **Edit collection** control opens the existing collection dialog; administrators can search and select Essential reading orders there, as well as set branding and pinned order. Saving changes only membership in that collection, preserving other collection assignments. Unchecking an order does not delete it. Supporting guidance uses the shared tooltip rather than permanent page copy.

Manual series boxes reuse the searchable membership picker inside their existing editor. Changes are committed with Save and discarded with Cancel. Smart boxes retain their rules; My Pull Box retains its Pull controls.

## Series deletion

Series detail Manage includes **Delete series**, for administrators only. Its confirmation explicitly covers permanent deletion of the entire series folder and all users' reading progress. The server requires the current series name, checks the folder is strictly inside its library, refuses roots, shared/nested series folders and symbolic links, and blocks active downloads. Deletion runs under the shared library write barrier. Only the selected series' monitoring is removed; separately stored annuals stay. SQL constraints are checked before file removal; filesystem failures are reported and database changes roll back, but a partial filesystem deletion cannot be automatically undone.

Validation: registry/membership/permission tests, temporary-folder deletion tests, production frontend build, and local browser fixtures at 1440, 820 and 390 pixels. No live comic files were deleted during validation.
