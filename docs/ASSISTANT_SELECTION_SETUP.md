# Assistant selection setup

Stage 3 of claude/BOXES_UNIFIED_PLAN.md. Before Comic Book Guy builds anything new (a reading order or a box of series), the reader answers a short form. Rewritten 2026-11-04 after review of the first version.

## Who decides when to ask
- Quick Answers always sees the question first, so saved reading orders are still checked first, line/universe pushback still happens, and plain questions ("is there a reading order for…", "what are the best X stories?") get answers, not a form.
- Quick opens the form with `ask_reader` (kind, subject, saved orders that cover part of it, and `format` when the reader named a box or an order).
- A `hand_off` to the Reading List Generator for a new list also opens the form (format preset to order), never a list built on inferred choices.
- On a reading list page, questions edit that list as before; a request for something new (a box, a different list) lets the generator open the form instead. A form sent from that page builds new; it never edits the open list.

## The questions (backend/ai/selectionSetup.js; options from ai/intake.js)
1. A box of series, or a reading order.
2. Box: only series in Omnibus, or include missing ones (named in the answer, not added); then a short stack (about 10) or a full box (about 25).
   Order: what matters most (stock options for the kind; a theme has one option, so it is skipped), then where to begin (character, team, creator, custom only): the beginning, a modern jumping-on point, or a particular era/story (typed).
3. Optional notes.

No defaults, no review screen; one button builds. Every shown question must be answered; the server re-validates and rebuilds wording from its own stock.

## What happens after
- Order: Reading List Generator with the intake brief (Built for…, start and notes as reader notes). The "Built for … Also available" rebuild buttons work as before and keep the notes.
- Box: Long Answers with the box brief. Only series refs found in the library are offered as a box preview, named after the subject. Saving is explicit (private personal box via POST /api/collections and /series). A failed series add retries into the same box; the saved box id is kept in the chat history so a reload cannot save it twice.

## Missing series (built 2026-11-04, backend/boxMissing.js)
- With "Include series Omnibus doesn't have yet", Comic Book Guy lists them in `missing_series` (title, start year, publisher, reason); Omnibus series go in `box_series` (up to 30, verified ids). A "missing" series the library has joins the box instead.
- The preview lists both; saving the box saves the missing ones as placeholders (`collection_missing_series`, POST `/api/collections/:id/missing`).
- Comic Vine: each placeholder is searched once, in the background lane of the shared rate-limit pool (same name; year exact or ±1; no match → name only). Same name and year in another box reuses the result. A refusal or no API key leaves them pending; viewing the box retries (at most every 10 minutes).
- Box page: "Not in Omnibus yet" dashed tiles (Comic Vine cover, year · publisher · issues, reason, Comic Vine link), ⬇ Add (Download Manager search) for users who may download, otherwise ✉ Request (prefilled; shows Requested once asked). Owners can remove one.
- When the library gets the series (same Comic Vine id, or name and year) it moves into the box on the next view. Copying a box copies them; deleting removes them.

## Tests
backend/ai/assistantRouting.test.js (setup section), backend/boxMissing.test.js, frontend/src/components/SelectionSetup.test.jsx (form and box preview), frontend/src/components/BoxMissingSeries.test.jsx.
