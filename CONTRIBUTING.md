# Contributing to Omnibus

Thanks for your interest. Omnibus is a hobby project, built mostly with AI coding assistants for one household, so please keep expectations relaxed: reviews happen when time allows.

## Reporting bugs and ideas

- **Bugs:** open an issue with the bug report form. Include your install type, the image tag or commit, and the relevant lines from the log (Settings › System › Live Logs, or the `logs` folder).
- **Ideas:** open an issue with the feature request form before writing code for anything large, so we can agree on the approach first.
- **Security problems:** report them privately. See [SECURITY.md](SECURITY.md).

## Making changes

1. Fork the repository and create a branch.
2. Set up and run the checks described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md):
   ```sh
   npm ci --prefix backend
   npm ci --prefix frontend
   npm test --prefix backend
   npm run test:helpers --prefix frontend
   npm test --prefix frontend
   npm run build --prefix frontend
   ```
3. Add or update tests for what you change.
4. Open a pull request that explains what changed and why. The same checks run automatically.

Small, focused pull requests are much easier to review than large ones.

## Ground rules

- **No copyrighted content.** Do not add comics, cover art, character art or publisher logos. Use public-domain material for tests and screenshots.
- **No secrets.** Never commit API keys, tokens, `.env` files or databases.
- **AI-assisted code is welcome.** Read and test it before submitting, the same as any other code.
- **Licensing.** Contributions are released under the project's [MIT License](LICENSE).
