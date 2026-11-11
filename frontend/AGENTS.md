# Frontend development

Comic is the only supported skin. Comic (OLD), Wood and Panel were retired on October 26, 2026. Do not recreate legacy page copies or alternate-skin branches as part of routine maintenance.

Read [SKINS.md](SKINS.md) before changing page designs or shared styling. It describes the current presentation and points to shared components.

- Reuse existing components, behavior helpers and CSS tokens before adding page-specific implementations.
- Keep dynamic values (such as sampled cover colors and measured dimensions) local when appropriate; put repeated static styling in shared stylesheets.
- Preserve permissions, destructive-action confirmations, reading progress, navigation state and offline behavior when consolidating UI code.
- Keep temporary previews and session notes in the ignored `_work/` or `_backups/` directories. Update maintained documentation when behavior changes; do not append session-by-session reports to this file.
- Do not deploy unless explicitly requested.
