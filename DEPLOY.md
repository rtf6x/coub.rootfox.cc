# Deployment

Static site on Cloudflare Workers (static assets), media on Cloudflare R2.

## Architecture

```
GitHub (public)
├── src/              → Cloudflare Workers (dist/, without videos/)
└── src/videos/       → GitHub backup + R2 sync via Actions

media.rootfox.cc/coub/  → R2 bucket (custom domain)
coub.rootfox.cc         → Cloudflare Workers
```

Media URLs in production: `https://media.rootfox.cc/coub/{filename}.video.mp4`

## Cloudflare deploy (Workers & Pages)

Cloudflare merged Pages into Workers. Use **Create application** → connect Git.

| Field | Value |
|-------|-------|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Builds for non-production branches | optional |

`wrangler.toml` points assets to `./dist` (built without `videos/`).

After first deploy: project → **Settings** → **Domains & Routes** → add `coub.rootfox.cc`.

## Cloudflare R2

### 1. Create bucket

Cloudflare Dashboard → R2 → Create bucket (e.g. `rootfox-cdn`).

### 2. API token

R2 → Manage R2 API Tokens → Create token with **Object Read & Write** for the bucket.

Save:

- Account ID
- Access Key ID
- Secret Access Key

### 3. Public access via custom domain

R2 bucket → Settings → Custom Domains → Connect `media.rootfox.cc`.

Files are served from bucket keys like `coub/2inylh.video.mp4`.

### 4. CORS (optional)

Only needed if you fetch media via `fetch()` from JS. `<video>` / `<audio>` tags do not require CORS.

## Cloudflare R2

Workflow: `.github/workflows/sync-r2.yml`

Triggers on push to `main`/`master` when `src/videos/**` changes, or manually.

Uploads only files that do not already exist in the bucket (`HeadObject` check).

### Repository secrets

| Secret | Description |
|--------|-------------|
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |
| `R2_BUCKET` | Bucket name |

### Repository variables (optional)

| Variable | Default |
|----------|---------|
| `R2_PREFIX` | `coub` |

### Local sync (optional)

```bash
export R2_ACCOUNT_ID=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export R2_BUCKET=rootfox-cdn
npm run sync-r2
```

## Adding new coubs

1. Download media into `src/videos/` (`npm run fetch -- ...`).
2. Update playlist JSON (`normal.json`, `funny.json`, `doom.json`).
3. Commit and push - GitHub Actions uploads only new files to R2.
4. Cloudflare redeploys the site without bundling videos.
