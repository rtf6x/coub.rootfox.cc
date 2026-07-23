# Deployment

Cloudflare Pages via CI (`wrangler pages deploy`), media on R2.  
Same pattern as `blog`: **no Git connection in Cloudflare**.

## Architecture

```
GitHub push
├── src/ (not videos)  → Actions: Deploy to Pages → Cloudflare Pages (coub)
└── src/videos/        → Actions: Sync media to R2 → media.rootfox.cc/coub/

coub.rootfox.cc        → Pages project "coub"
```

## One-time setup

### 1. Delete wrong Worker project

Remove `rootfox-coub` (Worker with Git) from Cloudflare dashboard if it exists.

### 2. Cloudflare API token

Dashboard → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template  
(or custom with **Account / Cloudflare Pages: Edit**).

### 3. GitHub secrets

| Secret | Value |
|--------|-------|
| `CLOUDFLARE_API_TOKEN` | API token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCOUNT_ID` | same account ID |
| `R2_ACCESS_KEY_ID` | R2 token access key |
| `R2_SECRET_ACCESS_KEY` | R2 token secret |
| `R2_BUCKET` | bucket name |

### 4. R2 custom domain

Bucket → Settings → Custom Domains → `media.rootfox.cc`.

### 5. Pages custom domain

After first deploy: Pages → **coub** → Custom domains → `coub.rootfox.cc`.

## Workflows

| Workflow | Trigger |
|----------|---------|
| `deploy.yml` | push to `main` (site files), or manual **Run workflow** |
| `sync-r2.yml` | push when `src/videos/**` changes |

## Adding new coubs

1. Add files to `src/videos/`, update JSON playlists
2. `git push` → R2 sync uploads new media
3. Push site changes → Pages redeploys automatically
