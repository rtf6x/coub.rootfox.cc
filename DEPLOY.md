# Deployment

Cloudflare Pages via CI (`wrangler pages deploy`), media on R2.  
No Git connection in Cloudflare (same as `blog`).

## Architecture

```
GitHub push
├── src/ (not videos)  → Deploy to Pages → coub.rootfox.cc
└── src/videos/        → Sync media to R2 → media.rootfox.cc/coub/
```

## GitHub secrets

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Pages deploy |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID |
| `R2_ACCOUNT_ID` | Account ID |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_BUCKET` | Bucket name |

Optional variable: `R2_PREFIX` (default `coub`).

## Workflows

| Workflow | Trigger |
|----------|---------|
| `deploy.yml` | push to `main` |
| `sync-r2.yml` | push when `src/videos/**` changes, or manual run |

First R2 upload: run **Sync media to R2** manually once if videos were already in the repo.

## Adding new coubs

1. Add files to `src/videos/`, update JSON playlists
2. `git push` → R2 sync uploads new media, Pages redeploys site
