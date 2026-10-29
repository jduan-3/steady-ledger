# Security and private data

Steady Ledger is a self-hosted application. Each installation creates its own local data directory and model configuration.

- Keep `data/`, SQLite databases, `secret.key`, model credentials, backups, conversations, uploaded avatars, and screenshots out of public repositories.
- `.gitignore` excludes local data, runtime output, private development notes, environment files, and browser artifacts. `.dockerignore` also excludes them from image build contexts.
- Run `npm run check:public` before committing or publishing. It checks tracked and publishable untracked files without printing credential values.
- The `examples/` directory contains synthetic fixtures. Do not replace them with a personal export.
- Use `npm start` for password-protected hosting. `npm run local` disables login and binds only to the loopback address; do not expose that entry point publicly.
- API keys are encrypted at rest, but anyone with both the database and the local encryption key can decrypt them. Store complete backups privately.
- Model requests go to the provider configured by the owner, under the selected data permissions. The public repository contains no shared model key or financial account.

If a secret has already been published, revoke or rotate it first. Removing the current file does not remove it from Git history.
