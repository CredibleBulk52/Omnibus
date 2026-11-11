# Backups and recovery

How Omnibus protects its data, how to restore it, and how to deploy and check a running install. Paths below are relative to the folder that holds `docker-compose.yml` (your *install folder*); change them in `.env`.

## What needs backing up

| Data | Where it lives | Covered by |
|---|---|---|
| Comics | Your comics folder (`COMICS_HOST_PATH`) | Your own backups; Omnibus does not copy comic files |
| Database: users, reading progress, lists, boxes, monitored series, settings | `/appdata/omnibus.db` in the `omnibus-data` Docker volume | Automatic daily backups (below) |
| API keys and secrets | `.env`, plus keys saved in Settings (encrypted in the database with `OMNIBUS_SECRET` from `.env`) | Keep a copy of `.env` in a password manager; without `OMNIBUS_SECRET` saved keys cannot be decrypted |

## Database backups (automatic)

Every day at 09:30 UTC Omnibus copies the database to `./_backups/db/omnibus-YYYY-MM-DD-HH-MM.db`, checks each copy's integrity and keeps the newest 14. Change the folder with `DB_BACKUP_HOST_PATH` and the count with `DB_BACKUP_KEEP` in `.env`.

Admins manage backups in **Settings › Backups**: take one now, pin a copy so it is never pruned, set a **second copy** folder (another drive or a NAS; mount it with `BACKUP_COPY_HOST_PATH` and choose `/backup-copy`), and **Restore**.

**Restore** checks the chosen backup, lets running work finish, restarts, and swaps the database in before it opens. The database it replaces is kept as `before-restore-*.db`.

Do not `docker cp` a database into a running container: a plain copy can leave a truncated file ("database disk image is malformed"). If the app will not start and you must restore by hand, copy through a throwaway container while Omnibus is stopped:

```
docker stop omnibus
docker run --rm --volumes-from omnibus -v "<backup folder>:/b" alpine sh -c "cp /appdata/omnibus.db /b/before-restore.db; mkdir -p /appdata/stale; mv /appdata/omnibus.db-* /appdata/stale/ 2>/dev/null; cp /b/FILE.db /appdata/omnibus.db"
docker start omnibus
```

## Deploying an update (building from source)

On Windows, `.\deploy.ps1` (run from the install folder) syntax-checks the server, saves the running image as `omnibus-omnibus:previous`, builds while the old version keeps running, starts the new one, waits for `/api/health`, and puts the previous version back automatically if the new one does not come up. `.\deploy.ps1 -Rollback` switches back by hand (one deploy only). If Windows blocks the script, run `powershell -ExecutionPolicy Bypass -File .\deploy.ps1`.

With the published image: `docker compose -f docker-compose.prod.yml pull` then `docker compose -f docker-compose.prod.yml up -d`.

## Logs

Everything the server prints is also written to `./logs/omnibus-YYYY-MM-DD.log` (UTC dates), kept 14 days, so logs survive rebuilds. Override with `LOG_HOST_PATH` / `LOG_KEEP_DAYS`. `docker logs omnibus` covers only the current container.

## Health status

Docker checks Omnibus every 60 seconds (`HEALTHCHECK` in the Dockerfile) and shows the result in `docker ps` and Docker Desktop.

- **healthy**: the server answers, the database works, and the comics folder is visible.
- **unhealthy**: three checks in a row failed: the server did not answer within 10 seconds, the database failed, or `/comics` is missing or empty (on Windows, usually the drive is no longer shared with Docker Desktop).
- **starting**: the first 90 seconds after a start.

Docker only reports the status; it does not restart the container. To check it:

```
docker inspect --format "{{.State.Health.Status}}" omnibus
docker inspect --format "{{json .State.Health.Log}}" omnibus
```

A missing comics folder is a sharing or `COMICS_HOST_PATH` problem, not a code problem: fix it, then `docker compose up -d --force-recreate`.
