# My Pull Box

## Behavior
- + Pull follows a scanned series in one private, manual, all-library box per account. Admins have private pull boxes too. Opening My Pull Box alone does not create a record.
- The purpose field identifies the box, independently of its display name. It cannot become a Smart box or acquire a library scope. Deleting the box removes its membership, not comics or reading progress; a subsequent + Pull creates another.
- My Pulls uses the same store/publication date definition as Recently Released. It filters followed series before taking the latest 30 available issues, across all libraries. It is not a download queue, unread-only list, or date-added feed. Future and undated releases are excluded. Late-arriving older issues retain their publication position.
- + Pull shows a request action when the series is not actively monitored. This reuses My Requests and does not start acquisition.
- Favorites are no longer displayed as a shelf or heart. Each user may explicitly import or skip their valid favorites; old data is retained. Import copies series, never progress or download settings.
- My Stuff order: My Pull Box, Offline, Reading Lists. Existing lists remain intact.
- Comic Boxes keeps personal boxes first, with a compact empty state. Admin-created personal boxes explicitly use private ownership. Library box card counts match the all-library detail contents. Optional card descriptions are edited in the existing editors and limited to 140 characters.

## Data and rollout
`backend/pullBox.js` performs additive, repeatable schema initialization: collections.purpose, collections.card_description, a unique owner index for purpose='pull', and pull_preferences. No production database was changed during implementation; initialization runs on the next normal server start. The normal server/deployment backup process should remain in use.

Code backup: `_backups/code/pull-box-1793690616892/`. It contains the pre-change versions of touched existing files. New files are pullBox.js / pullBox.test.js, PullBox.jsx / PullBox.test.jsx, PullBoxPage.jsx, pullBox.css and public/pull-box.svg. Rollback should restore only feature-related changes if later edits exist. Additive schema fields can remain when reverting code; do not remove the user's original favorites, boxes or progress.

Relaunch recommendations are deferred; following a series follows that specific series record.

## Validation
Backend regression tests use an isolated in-memory database, including private admin ownership, cross-user mutation rejection, conversion safeguards, idempotent favorite import and filtering before the release limit. Frontend tests cover membership, the existing request dialog, release switching and empty states. A temporary frontend copy is used for production builds and visual checks without running the production backend.
