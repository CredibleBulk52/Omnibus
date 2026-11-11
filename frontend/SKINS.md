# Frontend presentation

Current reference, reviewed October 26, 2026. Comic is the only supported skin. Comic (OLD), Wood and Panel and their legacy page branches have been retired.

## Theme and styles

- [theme.js](src/theme.js) keeps `data-theme="comic"` on the document for existing CSS selectors and removes the old browser skin preference. It is not a skin picker.
- [App.css](src/App.css) defines shared colors and base styles. Prefer its CSS variables over repeated literal colors.
- Page and component stylesheets live beside the other styles under `src/`. Scope page-specific rules to their page; shared changes affect all consumers.
- Inline values remain appropriate for dynamic colors, positions and measurements. Repeated static styling belongs in reusable classes or components.

## Reuse before adding another implementation

| Need | Existing implementation |
| --- | --- |
| Dialogs and confirmations | [Modal](src/components/Modal.jsx), [ConfirmProvider / useConfirm](src/components/Confirm.jsx) |
| Loading, empty and error states | [StateMessage](src/components/StateMessage.jsx) |
| Back navigation and history | [BackLink](src/components/BackLink.jsx), [navTrail](src/components/navTrail.js) |
| Management menus and admin actions | [ManageMenu](src/components/ManageMenu.jsx), [AdminBar](src/components/AdminBar.jsx) |
| Collection/list presentation | [ReadingOrderHero](src/components/ReadingOrderHero.jsx), [CuratedMast](src/components/CuratedMast.jsx) |
| Comic titles and shelves | [ComicInkTitle](src/components/ComicInkTitle.jsx), [ReadingListShelf](src/components/ReadingListShelf.jsx), [ShelfScroller](src/components/ShelfScroller.jsx) |
| Curated-list editing | [ListEditor](src/components/listEditor/ListEditor.jsx) and its adapters |

Inspect each component's props and existing uses before extending it. Reuse should retain focus behavior, responsive layouts, permissions and confirmation behavior.

## Character and cover palettes

[ReadingTheme](src/components/ReadingTheme.jsx) uses recognized title identities from [readingPalettes.js](src/themes/readingPalettes.js), otherwise [useCoverPalette](src/components/useCoverPalette.js) supplies cover-derived colors. [seriesPalette.mjs](src/themes/seriesPalette.mjs) implements the regional sampling logic. These are display choices, not metadata corrections.

Preserve intentional cover variation and neutral fallbacks. Ambiguous names should not be forced into an unrelated character palette. The account Appearance menu controls app colors and whether reading pages use character/cover colors.

## Verification and history

Use the relevant component/helper tests and a production build for behavioral changes. Check responsive layouts, keyboard focus and reduced-motion behavior when altering presentation. Do not report fixture tests as live-browser or deployed validation.

The former skin-preservation log and completed palette audit are preserved locally under `_backups/docs-archive/markdown-cleanup-2026-10-26/frontend/` and in Git history. They describe historical decisions, not instructions to restore retired features. Keep future design references concise; put dated session reports in the ignored archive.

## Optional shared branding

PublisherLogo replaces display labels in Timeline publisher controls, catalog publisher headings, Series hero badges and event detail metadata. It preserves readable text when no upload is available. CharacterSymbol uses the existing unambiguous palette identity independently of the page-color setting; Series and the shared ReadingOrderHero display it only when an asset exists. Same-color identities remain separate; aliases within one identity share a symbol.

Library → Publishers & weekly releases → publisher → Branding manages publisher images and aliases. Library → Character symbols manages identity uploads. No upload affordances or empty slots appear on reader pages. Images retain their aspect ratio within context-specific bounds; display size can be reduced in settings. PNG/JPEG uploads are validated and converted to bounded PNGs; artwork and aliases persist in the database branding_assets table and database backups. Endpoints require authentication; mutations require admin. Do not modify library metadata when changing branding.

Publisher hero logos use standalone artwork without the Series badge backing. In Series heroes, the publisher sits at the upper right opposite Back navigation, above the reading card. Publication dates, era, status and counts remain in a compact row below the title; the character symbol stays beside the title. The separate year is omitted when already represented in the title or publication dates. Timeline event cards replace their publisher label with larger context-sized logos. Hero symbols sit beside the main ink title; subtitles align with title text, and absent symbols reserve no space. Top Shelf detail resolves publisher identity from linked volume and matched issue/series metadata; conflicting publishers produce no label. Shared branding aliases participate in resolution.

Branding uploads preview before saving, trim fully transparent margins automatically, and offer per-edge cropping for opaque backgrounds. Adjust crop can reprocess existing artwork; cancelled previews do not change shared images. Cropped-out content requires re-uploading the original. Server validates crop bounds after image orientation and retains aspect ratio; no automatic opaque-background removal.
Publisher marks with width/height up to 1.25 receive 30% additional height within the existing width bounds; wide wordmarks and compact filter buttons retain their limits. Shape is detected from loaded artwork, including existing uploads. Character-symbol sizing remains independent. Branding previews label filter, heading and hero contexts.
## Character motif themes

The Appearance gallery offers ten themes from themes/characterThemes.js: Superman, Batman, Green Lantern, Harley Quinn, Joker, Captain America, Iron Man, Hulk, X-Men and Fantastic Four. Old character and era presets are retired from the menu. Existing saved colors remain custom colors; do not migrate or erase them. Reset to default restores undecorated Omnibus.

ThemeMotif renders shared decorative SVG artwork in PageHeader and the gallery previews. Motifs are hidden from accessibility APIs, never intercept input, contain no animation, and do not alter reading-page heroes or metadata. The account stores themeId and decorations independently of color choices, so users can customize colors or turn artwork off. Unknown/retired IDs resolve to no motif. Sign-out clears theme and colors.

The optional action color and bannerText color support bright banners without making small text unreadable. Banner lettering can be purple on Hulk green or deep blue on X-Men yellow while global highlights remain light. Generic buttons choose a contrasting foreground for explicit actions. The optional fields survive server validation, local cache and account reload; missing fields retain legacy behavior. Match selected presets using both identity and colors.

Preserve the existing reading-page palettes in characterColors.js. Their paletteTokens continue to darken banners and select readable foregrounds independently. When character/cover colors are off, the user's action color becomes the reading-action color.
PageHeader motifs measure the free space between the title and right-side information and center their emblem within that gap. ThemeArtwork shares the approved art with preset thumbnails. Resize and content observers update the placement when titles, counts, fonts or width change. Artwork is hidden below 600px, when the free gap is under 180px, or when the information wraps onto a different row; headings and controls retain their layout. Superman’s cape meets the lower edge; Lantern uses an energy burst and trails. Harley has layered diamonds at varied scales and angles. Joker uses custom jagged vector lettering clustered around the mouth with progressively wider spacing toward the edges. Hulk has tapered fractures. Captain America keeps red global highlights and white banner lettering. Saved colors remain unchanged; reselect a preset to apply its revised colors.

## Homepage panels and shared navigation

Home uses a full-width comic-panel composition in homePanels.css. HomePageComic retains the home/v2 and discover selection rules, Continue Reading destinations, event grouping, Hide/Clear behavior, favorites, characters, cover sizes and native wheel scrolling. HomeFeatures presents daily-stable Top Shelf, Essentials and Timeline spotlights with separate item and catalog links. Top Shelf uses the existing global curated catalog; Essentials respects catalog library associations; Timeline follows unambiguous DC/Marvel library names; series and boxes use library-filtered data. The release panel scrolls vertically on desktop/tablet and horizontally below 600px. Empty catalogs retain useful catalog links. No random background or heavy shelf plank is used on Home.

Optional home_tagline (120 characters) and home_description (400 characters) belong to the existing editor Details sections for events, runs and admin-managed Essentials. They save in the existing transactions and version checks; empty values fall back to title and description. There is no separate homepage editor or writing endpoint. Columns are added idempotently at startup; ordinary metadata saves preserve them. Homepage editorial panels use restrained reading-palette tints for runs and Essentials, and the shared Timeline tier color for events, behind halftone dots. Account themes color the page shell, captions, controls and highlights. Artwork columns are bounded on wide screens; Essentials uses the shared cover fan. Continue Reading reads the home API’s top-level page value and metadata page count, with a visible progress track and a separate series/event link. Unknown page totals show the page number without inventing a percentage.

Sidebar and bottom navigation share destination groups. Below 768px the five controls are Home, Browse, Must Reads, My Stuff and More. Group dialogs explain curated destinations; tool access retains existing admin/download permissions. The existing top search remains available. The local implementation preview uses fixture data, not production user progress.

Homepage curated panels allow taller artwork and larger editorial context: actual Top Shelf category labels, Essentials journey progress, and Timeline tier/year/publisher. Essentials fans show up to three distinct covers at their natural aspect ratio. Decorative panels use overflow:clip; the Home shell leaves vertical scrolling to the document while release and cover rails remain independently scrollable.

Home’s Refresh picks control rotates Must Read and Browse selections through eligible loaded catalogs, retaining library filtering and leaving Continue Reading/Recently Released untouched. Initial picks retain the daily/featured preference; manual rotation can discover the rest of the catalog. Continue Reading dismiss controls appear on card hover or keyboard focus; touch devices keep them visible.

Home retains its two-column editorial layout from 600px upward, including portrait tablets; narrower phones stack cards. Top Shelf and Timeline artwork is capped at 290px on wide screens to limit portrait cropping, and full-cover reveal adds only 3% scale. Browse Series clips its cover at rest and permits overflow only during hover/focus on pointer devices.

Home spotlights and manual rotation follow a deterministic shuffled catalog order, avoiding consecutive ID/alphabetical sequences and repeats within a cycle. Essentials glow uses the shared reading-theme highlight token; its foundation retains the primary tint. Home story actions reuse btn/btn-primary and catalog browsing uses btn/btn-secondary.

Homepage feature actions use the compact comic-action treatment from comicSeriesHero.css, with solid ink borders and shadows. Top Shelf and Essentials inherit their shared reading-palette action and foreground tokens; other panels fall back to the account action colors.

## Personal pulls

`PullBox.jsx` reuses reading-order utility buttons, inherited character colors, Confirm and RequestSeriesDialog. Series Manage owns + Reading List and + Box; issue Manage exposes + Reading List to readers while keeping maintenance admin-only. Favorites UI is retired; saved favorites remain available for optional import.

`PullBoxPage` opens the current user's purpose-tagged personal box; viewing an empty state creates nothing. Homepage `ReleasePanel` switches between library-scoped Recently Released and all-library My Pulls, remembers the tab per user, and retains the shared release rail. Pulling does not enable monitoring or downloads.

The Comic Box page lists personal boxes first, with the pull box first. Shared and personal box editors expose optional 140-character Card description; existing description is the fallback. Box scenes measure their available grid cell so phones/tablets retain the artwork without horizontal overflow. Default Pull Box artwork is `/pull-box-art.png`; normal cover uploads can replace it.


## Download workflow and search

Download Manager uses compact, theme-aware operational controls. Wanted groups by series ID, preserving separate volumes with the same title, and distinguishes failed loading from an empty list. Requests separates handled requests from issue availability; Reports supports search and category filters with per-report reply/resolution controls. Existing role checks and action permissions remain in place.

Import separates scanning, match review and results. Only matched, unmonitored folders are eligible; failed or partially failed executions remain visible as errors. Logs retains the latest 500 streamed entries while following is paused; scrolling affects only its own viewport. Filters and copy operate on the retained entries.

Search gives Essentials its own result category. Issue results expose separate reader and series links; metadata-maintenance badges are admin-only. New searches invalidate older responses, including when clearing the query or changing library scope.
