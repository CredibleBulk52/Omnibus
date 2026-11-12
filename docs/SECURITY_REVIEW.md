# Security review (November 2026)

A focused review of Omnibus 2.0.0, done on 2026-11-12 with an AI coding assistant. It is not an independent audit. It looked for the problems most likely to matter for a self-hosted household app, fixed what it found, and lists what remains.

Fixes ship in version 2.0.1.

## What was checked

| Area | What was looked at | Result |
|---|---|---|
| Access control | About 400 API routes: which need a sign-in, which need an admin, and whether lists, boxes and reports check who owns them | Sound. The API refuses requests without a sign-in by default; only sign-in routes and cover images are public. Admin-only areas are checked by path and by route. Lists and boxes check ownership on every change. |
| Sign-in | Password storage, session tokens, sign-out, password changes, single sign-on | Sound, with one gap (fixed): no limit on failed sign-ins. Passwords use scrypt; sessions can be revoked and end when a password changes; single sign-on checks its state and never links an account by name. |
| File access | Reader, cover, folder-browse, import and download routes | Sound. Paths are resolved and checked against their root folder, including links. |
| Archive extraction | Comic files and download packs from the internet | Sound. Extraction uses the tools' safe defaults (no absolute paths or `..`), then checks real paths and skips links an archive creates. |
| Outgoing requests | Features that fetch an address a user supplies | One gap (fixed): direct downloads accepted any address. |
| Shared content | Lists, boxes, descriptions and assistant answers shown to other users | Sound. The app never inserts raw HTML; text is escaped. One small hardening (done): assistant source links are limited to web addresses. |
| Uploads | Box and list covers, branding images, assistant portrait | Sound. Size limits, image file types only, file names chosen by the server; the portrait is re-encoded. |
| Dependencies | `npm audit` on the backend and frontend | Two issues (fixed): `sharp` and `uuid`. |
| Browser protections | Response headers and cross-origin access | Two gaps (fixed): no protective headers, and any website could call the API. |

## Fixed in 2.0.1

1. **Unlimited password guessing.** Sign-in now refuses an account after 20 failures in 15 minutes, and an address after 30, with a "try again in" message. A correct password clears the account's count. (`backend/authSecurity.js`, `createLoginLimiter`)
2. **Downloads from any address.** Any user with Download Manager access could make the server fetch an address on your home network (a router page, another service, a cloud metadata address). Direct downloads now accept only `http` and `https` addresses on the public internet, checked again after a GetComics link is resolved. (`backend/urlSafety.js`)
3. **Image library flaws.** `sharp` 0.33 bundled versions of libvips, libheif and librsvg with published high-severity flaws. Updated to 0.35.5.
4. **`uuid` advisory.** Not reachable here (`node-cron` only calls `uuid.v4()`), but pinned to 11.1.1 so `npm audit` is clean.
5. **Browser protections.** Every response now sends `X-Content-Type-Options: nosniff` and `X-Frame-Options: SAMEORIGIN`. The open cross-origin (CORS) setting was removed; the app and API share one origin.
6. **Assistant source links** only link to `http` and `https` addresses.

## Known limits (not changed)

- **The container runs as root.** Running as a regular user would limit the damage from a future flaw, but it would change folder permissions on existing installs. Planned for a later version.
- **Downloads are open to every signed-in user by default.** Turn on **Restrict Download Manager to admins** (Settings › People › Access Control) if not everyone in your household should start downloads.
- **Download clients fetch what they are given.** SABnzbd and qBittorrent fetch the NZB and torrent addresses that Omnibus passes on. Those addresses normally point at Prowlarr on your own network, so they cannot be limited to the public internet.
- **Redirects are not re-checked.** A public download address that redirects to a private one is still followed.
- **Sessions are stored in the browser** (local storage). A script injected into the page could read them; no such injection was found.
- **No Content Security Policy.** It would add defence in depth but needs testing against the reader and themes.
- **Series tags are shared.** Any signed-in user can remove a tag that someone else added.
- **Development-only advisories.** The frontend's test tools (Vitest and its `tinypool` dependency) have advisories. They are not in the image.
- **Bundled license notices.** `licenses/native/libvips-NOTICES.txt` describes the libvips that came with `sharp` 0.33. The image build reports the version change as a review warning until the notices are refreshed.

## Reporting a problem

See [SECURITY.md](../SECURITY.md). Please report security problems privately.
