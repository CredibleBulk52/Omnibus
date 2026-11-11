# Automatic box artwork

Default artwork is decoration, not a genre classification. Custom uploaded covers and the dedicated Pull Box cover keep priority. The collection page's default front uses a separate live title layer with a dark backing and fitted text; generated art must be text-free, 2:1, and leave the center quiet.

## Selection

`backend/boxArtwork.js` maps tags to six families plus default. Each distinct series votes at most once per family. A unique highest count wins; ties, empty contents and unknown genres use default. Neutral superhero/setting tags do not vote. Reading orders reuse `catalogOf`'s series resolution, including matched books and named missing issues; unresolved series cannot vote. No issue-count weighting or title guessing.

Automatic recalculates on the next data load, not randomly or on every React render. There is deliberately no persistent automatic cache to invalidate: collection peeks reuse resolved membership and read database metadata in batches of 400; reading-order catalogs reuse the series rows already loaded. No image analysis, filesystem reads, new browser requests or external services are added by the selector. Existing membership/catalog work remains unchanged.

Manual family choices are saved in the idempotently created `box_artwork_preferences` table, keyed by kind and ID. `auto` restores automatic behavior. Authenticated PUT artwork routes enforce existing ownership/moderation rules. Uploaded covers always win; the family picker is shown only on default fronts. Choices don't change titles, genres, progress or membership.

## Artwork assets

`frontend/src/components/boxArtwork.js` is the asset manifest. Seven versioned WebP assets live in frontend/public/box-artwork. They are 1008 × 504, loaded lazily and shared across boxes. Replace a design with a new versioned filename and update the manifest to avoid stale browser caches; missing images fall back to the existing background. BoxDefaultArtwork renders images decoratively under the live title. No per-box image generation is required. Options: default, horror, scifi, fantasy, crime, comedy, adventure.

Manual artwork preferences are independent from existing copy/export flows: copies start Automatic unless they already carry uploaded art. Removing a custom cover reveals the saved default-art choice. The dedicated pull-box image is unchanged.
