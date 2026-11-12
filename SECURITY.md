# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what an attacker could do with it.

Do not include real API keys, passwords or personal data. Use made-up values in examples.

## What to expect

Omnibus is a hobby project maintained by one person. Reports are handled on a best-effort basis, with no guaranteed response time. Fixes ship in the `latest` image on Docker Hub once they are on the `main` branch.

## Supported versions

Only the current `latest` image and the `main` branch get fixes. Older image tags are not updated.

## Known limits

- No one has done a security audit of Omnibus.
- API keys saved in the app are encrypted with `OMNIBUS_SECRET`. Anyone with that secret and the database can read them.
- Omnibus is designed for a household behind a reverse proxy with HTTPS. Change the default `admin` password before exposing it to a network you don't control.
