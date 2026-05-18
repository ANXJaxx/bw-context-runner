# BW Context Runner

GitHub Actions workflow that calls each WP site's `/bw-context-linker/v1/process-next`
REST endpoint on a 30-minute schedule, generating AI-written internal-link
sentences via Groq for posts that haven't been processed yet.

## What lives here

```
gh-runner/
├── .github/workflows/backfill-context-links.yml   ← cron schedule + job
├── scripts/
│   ├── backfill-context-links.js                  ← the orchestrator
│   └── lib/
│       ├── load-config.js                          ← site list + creds loader
│       └── wp-client.js                            ← REST client
├── sites.json                                       ← 204 engine domains
├── external-sites.json                              ← 60 external domains
├── package.json                                     ← axios + dotenv only
└── .gitignore                                       ← excludes .env, .passwords.json
```

## How it runs

1. GitHub Actions fires the workflow every 30 min.
2. Workflow installs deps, loads `WP_USERNAME` + `WP_APP_PASSWORD` + `WP_PASSWORDS_JSON` from repo Secrets into env.
3. `backfill-context-links.js` loads the combined site list, walks each site round-robin.
4. For each site, calls `POST /wp-json/bw-context-linker/v1/process-next?batch=2` with paced delays.
5. Each site returns up to 2 newly-processed posts. Workflow continues until either all sites are fully backfilled or the 5h20m runtime cap is hit.

## Secrets to configure (one-time, in repo Settings → Secrets and variables → Actions)

| Secret name | Value |
|---|---|
| `WP_USERNAME` | Same value as your local `.env` |
| `WP_APP_PASSWORD` | Same value as your local `.env` (shared password for engine sites) |
| `WP_PASSWORDS_JSON` | Contents of your local `.passwords.json` file, pasted as a single multi-line value |

## Maintenance

- **Adding new sites** to the backfill list: update `sites.json` and/or `external-sites.json`, commit, push. Next cron tick picks them up.
- **Adding new per-site passwords**: update `WP_PASSWORDS_JSON` secret with the new JSON.
- **Pause backfill**: repo → Actions tab → "Backfill BW Context Linker AI sentences" → "..." menu → "Disable workflow"
- **Resume**: same menu, "Enable workflow"
- **Run-now (manual)**: Actions tab → workflow name → "Run workflow" button (top right) → adjust rpm/batch/max_minutes if needed → green Run button

## What this DOESN'T contain

- Your engine project (templates, deploy scripts, snippet.php) — those stay on your local machine.
- Plugin source code — lives on each WP site already, installed via `install-plugin-all.js` from your local machine.
- Any secrets — credentials only exist in GitHub Secrets and your local `.env` / `.passwords.json`.
