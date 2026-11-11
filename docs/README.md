# Documentation index

Start with the [project README](../README.md). This index separates maintained guidance from historical notes and issue-specific reference material.

| Document | Purpose and status |
| --- | --- |
| [Development and checks](DEVELOPMENT.md) | Install commands, test suites, CI publishing gate and remaining release checks. |
| [Backup and recovery](BACKUP.md) | Database backups, restore, deploys, logs and health checks for any install. |
| [AI models](AI_MODELS.md) | Task routing and provider integration. Dated model comparisons, prices and results are historical observations; source code defines current behavior. |
| [Metadata service](../backend/metadata/README.md) | Module boundaries, preservation rules, recovery constraints and verification limits. |
| [Frontend instructions](../frontend/AGENTS.md) | Active coding-assistant instructions for frontend work. |
| [Frontend presentation](../frontend/SKINS.md) | Current Comic presentation, shared components and palette behavior. |
| [Summary-writing instructions](ASTRA_SUMMARY_INSTRUCTIONS.md) | Standing instructions for external page-reading runs; retains the owner's host/output paths. |
| [Summary pipeline](SUMMARY_PIPELINE_BRIEF.md) | Implemented JSONL import and recap integration. |
| [Synopsis controls](synopsis-control/README.md) | Preserved issue-specific evaluation material; not general coding instructions or runtime prompts. |

## Historical notes

Completed plans, old audits and session handoffs belong in the ignored `_backups/docs-archive/` directory, not alongside active instructions. The October 26 cleanup preserved the original versions and a SHA-256 manifest in `_backups/docs-archive/markdown-cleanup-2026-10-26/` before editing or removing them. Git also retains committed history. Local archives are not included in a fresh clone.

Some source comments cite earlier `claude/*.md` project notes. Those are historical design references, not runtime dependencies or prerequisites for running the app. The files are not part of this checkout; consult the actual implementation, tests and maintained references above before acting on those comments.

## Keeping documentation useful

- Update the existing reference when behavior changes; avoid a second competing set of instructions.
- Distinguish implemented behavior, proposals and historical measurements explicitly.
- Keep secrets, private run output, temporary previews and session logs out of tracked documentation.
- Preserve reusable prompts and evaluation material unless their consumers have been checked.
- Put new operational or architecture references under `docs/` and link them here. Keep scope-specific `AGENTS.md` files beside the code they govern.
- Verify links and file paths after reorganizing documents. Markdown cleanup does not require deployment.
