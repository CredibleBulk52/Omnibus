# Development and checks

Use Node.js 22.13 or later (the container and CI major version) and npm. The frontend build and test tools (Vite 8, Vitest 5, jsdom 29) need at least 22.13, and some tests use `node:sqlite`. Node 24 can also run the fixture suites, but that does not replace container verification.

## Install from the repository root

```sh
npm ci --prefix backend
npm ci --prefix frontend
```

Both packages have committed lockfiles. Docker uses `npm ci` as well. Change dependency manifests and lockfiles together and commit both; do not regenerate dependency versions just to run a build.

The frontend is built with Vite 8 (`frontend/vite.config.mjs`; replaced Create React App 2026-11-03; upgraded from Vite 5 on 2026-11-12, whose stricter CSS minifier rejects malformed rules). Output keeps CRA's layout: `frontend/build/`, hashed files in `build/static/`, and an `asset-manifest.json` that `public/sw.js` reads. `npm run dev` starts the dev server on port 3000 with `/api` proxied to `localhost:9810`. The frontend also declares the Babel and jsdom tooling used by its Node-based helper tests.

## Run checks

```sh
npm test --prefix backend
npm run test:helpers --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend
```

- Backend and frontend helper tests use the Node test runner. `scripts/run-node-tests.cjs` discovers explicit test files and passes relative paths, avoiding shell-glob and Windows UNC-path differences.
- Frontend component tests run on Vitest (jsdom, `vi.mock` / `vi.fn`; a mocked default export is `{ default: … }`), once, without watch mode.
- Tests use temporary fixtures. Do not launch the live server or point fixture tests at the production database.
- Archive tests need 7-Zip; set `OMNIBUS_TEST_7Z` to its executable when it is not named `7z` on PATH. CI installs p7zip, libarchive tools and unrar-free. Some format-specific checks may skip when a required tool is unavailable; inspect skips rather than treating them as full coverage.
- The native production container includes its own archive tools. Linux container behavior, live providers, SSO/proxy cookies and existing user data still need appropriate smoke checks before deployment.

## CI and image publishing

[checks.yml](../.github/workflows/checks.yml) runs on pull requests, manual dispatch and calls from other workflows. It installs locked dependencies, runs all three test commands and builds the frontend on Node 22/Linux.

[docker-publish.yml](../.github/workflows/docker-publish.yml) retains the existing main/tag publishing triggers but now waits for the reusable checks job before logging into Docker Hub or building/pushing an image. A failed check blocks publishing. Fork pull-request checks do not require Docker Hub secrets.

This adds a workflow dependency; it does not configure GitHub branch protection or change repository visibility. The first GitHub run remains the verification of the hosted CI environment.

## Before making the repository public

- Verify local and SSO login, reader images, logout and offline reading against the deployed application.
- Confirm first-run setup in a clean environment, including a strong JWT secret, real host paths and the shared `omnibus-net` network. Replace the default administrator password before exposing an installation.
- Review current files and Git history for sensitive material. The earlier heuristic scan is not a guarantee covering every secret format or remote-only ref.
- Review bundled artwork and third-party binaries for redistribution permissions. The project MIT license does not replace their licenses.
- Confirm the new CI passes and configure desired branch protection separately.

JavaScript dependency resolution is locked. Base-image tags, Alpine packages and Python dependencies are not fully pinned, so this is not a claim of byte-for-byte reproducible container builds.

## Redistribution review (2026-10-27)

Scope: current tracked files, Dockerfile and npm lockfiles. This is an inventory of release questions, not a legal clearance or an inspection of published image layers. Historical artwork versions and provider content terms were not comprehensively reviewed.

| Area | Evidence | Before public distribution |
| --- | --- | --- |
| Assistant portrait | The release fallback in `frontend/public/assistant-default.png` is the Omnibus logo. Administrators can upload their chosen image; `backend/assistant.js` stores it as `assistant-avatar.png` in the data volume and serves it before the fallback. | User uploads are installation data, not release assets. A Simpsons portrait was formerly bundled; earlier commits and already-published images may retain it. Review historical distribution separately before making history public. Character branding in the assistant prompt remains unchanged. |
| Omnibus branding | The owner confirmed on 2026-10-27 that he created the Omnibus logo. Logo/icon variants and the default assistant image use that artwork. | Creator provenance confirmed by the owner. |
| Fonts | CSS loads Bangers, Boogaloo, DM Sans, Comic Neue and Bowlby One SC through Google Fonts. No font binaries are tracked. | Retain the family/source inventory. If self-hosted later, include each downloaded family's license and copyright notices. See [Google Fonts](https://developers.google.com/fonts/). |
| UnRAR | Docker downloads `rarlinux-x64-621.tar.gz`, installs `unrar` and now preserves the archive's license, acknowledgments and readme under `/usr/share/doc/unrar` before removing the temporary extraction. | The exact archive was inspected and its notice filenames verified; the build now checks the license and acknowledgments are nonempty. UnRAR is separately licensed, not covered by Omnibus MIT. The current [RARLab terms](https://www.rarlab.com/license.htm) distinguish UnRAR components; do not apply the RAR trial restrictions indiscriminately to UnRAR. |
| Native dependencies | Backend lockfile includes `@img/sharp-libvips-linuxmusl-x64@1.0.4` under LGPL-3.0-or-later. Docker also installs Alpine archive tools, Python packages and the Node base image. | Inventory the actual released image, retain applicable notices and establish the required source/relinking arrangements for distributed LGPL/GPL components. A lockfile alone is not a complete binary compliance inventory. See [sharp-libvips](https://github.com/lovell/sharp-libvips). |
| JavaScript notices | Most lockfile entries declare permissive licenses. Frontend build dependencies also include MPL and CC-BY entries; these are not evidence that each package ships in browser code. Two entries lack the modern license field: exit 0.1.2 and esprima 1.2.5. Matching local package copies contain LICENSE-MIT and LICENSE.BSD respectively. | Preserve notices for what is actually distributed, including generated frontend license files. Missing lockfile metadata is not the same as unlicensed software. The Dockerfile now copies the root Omnibus LICENSE and third-party notice index into `/usr/share/doc/omnibus`. |

The formerly bundled Simpsons portrait was replaced with the owner-created Omnibus logo. Existing uploaded avatars are unchanged. Docker dependency notice/source review remains outstanding; removing the portrait from the current tree does not remove it from Git history or existing releases.

Docker notice packaging: see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for in-image locations and remaining obligations. The build also saves installed Alpine metadata, Python package versions and the Node version. These inventories do not replace corresponding-source obligations. Local image-build validation was unavailable because Docker was not installed in the review environment; the next GitHub image build must validate these Dockerfile changes.

### Image license inventory

After a successful image publication, the Docker workflow pulls that exact digest and runs only `scripts/image-license-inventory.cjs` in a read-only container with networking disabled, no mounts, dropped capabilities and no application startup. It does not connect to the deployed server or inspect user data.

The workflow saves an **image-license-review** artifact containing the immutable image reference and a JSON report: installed Alpine packages (including source origins/commits where present), backend npm packages and their notice text, Python license metadata, native sharp package READMEs, generated browser notices and the required Omnibus/UnRAR documents. Download it from the workflow run's Artifacts section. Retention is 90 days; archive it separately with the release if needed longer.

This is a post-publication audit step, not a license-compliance gate: if collection fails, the image has already been published, although the workflow is marked failed. The report identifies material to review; it neither certifies compliance nor creates a corresponding-source offer. Base-image global npm tools, Alpine license texts, Python license-file contents and transitive native-library sources remain outside its complete coverage.

For the GPL/LGPL source review, use the report's installed versions and source-package commits to locate the matching upstream source, distribution patches and build recipes. Review bundled libvips dependencies from the shipped package README rather than treating sharp's Apache license as covering every native library. Retain and make the required matching source/build material available with the release under the applicable terms; do not assume a current upstream homepage provides the source for an old binary.

Local verification covered inventory parsing with synthetic Alpine and nested/scoped npm fixtures, notice selection, script syntax and workflow YAML. The Docker execution and report upload still require the next GitHub run.

### Reviewed image inventory

Reviewed the supplied inventory for `bulk88/omnibus@sha256:452df33c5a256193d922dae104af084785302cdbed0134e417d345af0533c70f`: Node v22.23.4, 60 Alpine entries, 185 backend npm entries and 20 Python distributions. All entries have license metadata. Omnibus LICENSE, the third-party index and all three UnRAR documents are present. This checks the report, not the live server.

The browser notice file contained copyright banners pointing to React/React Router license files, without their full texts. The build now collects full licenses from the installed frontend runtime dependency graph into `frontend/build/third-party-licenses.txt`; the image inventory requires that file. Local collection passed against eight installed runtime packages; a new Docker build remains necessary.

Both sharp-libvips glibc and musl packages at 1.0.4 are installed. The exact upstream musl package was inspected: it contains a license table in README and a `versions.json`, but no standalone license files. Its native stack includes libvips 8.15.3, glib 2.81.1, pango 1.54.0, librsvg 2.58.93, fribidi 1.0.15, libexif 0.6.24 and libheif 1.18.2. Full third-party notices and matching native source/build material remain to be assembled. Both shipped platform packages need coverage, even if only musl is used.

The Alpine report identifies source-package commits for packages such as BusyBox, apk-tools, wget, readline, gdbm and 7zip. Use those exact commits and versions for source preparation. Package-wide expressions can include alternative licenses or licenses for other subcomponents; do not label every entry containing GPL as imposing the same terms on every shipped file. Python entries list license filenames but do not prove their contents. Four other backend entries had no separately collected notice file; the collector now includes their READMEs for review, because licenses can be embedded there. Native component versions are now also recorded.

Outstanding work is binary redistribution packaging (native notices and corresponding-source arrangements), not a test failure or a finding of leaked credentials. This report does not by itself determine that Omnibus application code needs relicensing.
