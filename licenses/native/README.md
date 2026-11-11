# Collected native dependency notices

These are supporting materials for image `bulk88/omnibus@sha256:452df33c5a256193d922dae104af084785302cdbed0134e417d345af0533c70f`. They are not a complete license-compliance assessment.

- `alpine-NOTICES.txt` preserves standalone notices found in source archives for 19 Alpine package origins (27 installed package entries selected from GPL/LGPL/MPL metadata).
- `libvips-NOTICES.txt` preserves standalone notices found in sharp-libvips 8.15.3 sources and the original librsvg source release's Cargo.lock dependencies. This is a conservative reference collection, not an inventory of libraries compiled into the image.
- `coverage.json` records source provenance, notice hashes, reference image versions and archive-scan findings.
- `review-status.json` is generated inside each new image. It reports notice integrity and whether covered dependency versions differ from the reference image. It always distinguishes those checks from source completeness.

Within each archive section, original notice bytes are concatenated in archive order; the member list identifies the files. Upstream license alternatives and exceptions remain applicable to their respective components, not automatically to all of Omnibus.

## What blocks a build

Missing or modified collected notice files fail the integrity check. Dependency-version changes produce warnings and a persistent `review-needed` result; they do not stop the application build. The image inventory artifact includes this result. Passing either check does not certify redistribution compliance.

## Narrowed review scope

The 24 archives without a matching standalone notice file are collection findings, not 24 known license violations. See `scope-review.json` for the evidence-based triage:

- Benchmark/test dependencies and dependencies selected only for Apple, Windows or SPIR-V are outside the Linux runtime review of the original source dependency graph.
- Optional AVIF dependencies need attention only if that feature was enabled.
- SVG parsing, generated lookup tables and JPEG decoding remain relevant library families.
- The certificate package is installed; its located source-header notices are now preserved alongside the standalone notices.

No collected notice or source has been deleted on the basis of this triage.

## Important source-collection correction

The pinned sharp-libvips build script patches `zune-jpeg` to Git revision `eebb01b` from `https://github.com/ironpeak/zune-image.git`, then runs `cargo generate-lockfile`. Consequently, the original librsvg Cargo.lock is NOT proof of the exact Rust dependency versions compiled into the supplied binary. The collected 299 registry crates match that original lockfile, not a recovered final build lockfile. The patched Git source was not included in that registry collection.

The local 321 MB source archive is therefore reference material, not a verified complete corresponding-source release. Do not advertise it as one or promise that it fulfills every source request. The exact final dependency resolution/build materials remain an upstream-artifact question. Further auditing of every crate in the original lockfile would not answer that question.

## Practical release steps

1. Retain the project license and the third-party notices already packaged. Do not substitute a generic "licenses on request" sentence for those files.
2. Preserve each image's digest and generated inventory, including `review-status.json`.
3. For binary distribution, provide the source/build materials required for the actual shipped components through an applicable distribution method. Establish the final libvips build dependency resolution before presenting the local archive as complete. A source-download location has not yet been configured or published.
4. Keep source-repository publication separate from binary-image distribution. A repository containing the project's source and build recipes is a different deliverable from an assembled image containing third-party binaries.

Existing backend, Python, Node and base-image notices remain in their installer-provided locations. This pass did not audit every one of those texts or rebuild libvips. It does not establish a prohibited dependency, require relicensing Omnibus, or provide legal clearance.
