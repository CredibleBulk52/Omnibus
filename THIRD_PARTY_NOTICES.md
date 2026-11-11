# Third-party software and assets

Omnibus project code is licensed under the accompanying MIT LICENSE. That license does not relicense dependencies, operating-system components, fonts or user-uploaded content.

## Notices in the container

| Component | Location / upstream |
| --- | --- |
| Omnibus | /usr/share/doc/omnibus/LICENSE |
| UnRAR 6.21 | /usr/share/doc/unrar/license.txt, acknow.txt and readme.txt, copied unchanged from https://www.rarlab.com/rar/rarlinux-x64-621.tar.gz |
| Backend JavaScript packages | /app/backend/node_modules: each package's shipped license/notice files and metadata; /app/backend/package-lock.json records dependency resolution |
| Browser JavaScript | /app/frontend/build/third-party-licenses.txt contains full license texts for the installed runtime dependency graph; retain generated *.LICENSE.txt files in static/js as well |
| sharp / bundled libvips | Installed @img/sharp-* packages under /app/backend/node_modules; retain their license files, READMEs and third-party notices. https://github.com/lovell/sharp-libvips |
| Python packages | Installed package metadata and license files under Python site-packages; versions are listed in /usr/share/doc/omnibus/python-packages.json |
| Alpine packages | /usr/share/doc/omnibus/alpine-installed.txt records the installed APK metadata, including versions, license declarations and source-package origins where provided. This is not a collection of license texts. https://gitlab.alpinelinux.org/alpine/aports |
| Node base image | /usr/share/doc/omnibus/node-version.txt records Node's version; retain the base image's existing notices. https://github.com/nodejs/docker-node |

UnRAR is separately licensed. Only the unrar executable is installed from the RARLab archive; the rar executable and self-extracting module are not installed. The included RARLab documents describe a broader package and distinguish UnRAR components.

The frontend build directory is copied in full, including its generated license files. Backend npm packages and Python packages retain files supplied by their installers. These measures do not establish that every upstream package includes all required notices.

## Artwork and fonts

The Omnibus logo was created by the project owner. The default assistant image uses that logo. Custom assistant portraits are uploaded by an administrator into installation data; they are not included in releases. Users must have appropriate rights for content they supply.

Bangers, Boogaloo, DM Sans, Comic Neue and Bowlby One SC are requested from Google Fonts, rather than bundled as font binaries. If fonts are distributed locally in a future release, retain the exact families' license and copyright files. https://developers.google.com/fonts/

## Collected native notices

The container includes `/usr/share/doc/omnibus/native/`: collected Alpine and sharp-libvips source notices, a version and provenance index, and a README describing unresolved gaps. The build verifies notice-file integrity. Changes to covered dependency versions produce review warnings and a persistent status file, rather than blocking the build. This is a partial collection; consult its README before treating the image review as complete.

## Release obligations still to verify

This notice index and the package inventories are not a complete SBOM, source offer or certification of redistribution compliance. For each released image digest, review the actually installed native components and their applicable licenses. Preserve required license texts and provide the corresponding source, build material and replacement/relinking arrangements required by the applicable GPL/LGPL terms. Upstream links alone should not be treated as fulfilling those obligations.

The npm lockfile lists optional packages for multiple platforms and frontend build-only tools; it is not an exact inventory of distributed binaries. Alpine and Python versions also depend on when the image is built. Preserve the image digest and inventories when completing the release review.

The publishing workflow also produces an image-license-review artifact for the exact image digest. Its selected notice texts and package metadata aid review, but it is not a corresponding-source archive and expires according to workflow retention.
