# Consumer setup (Repo B)

This is the runbook for a **separate webapp repo** (Repo B) that consumes the
private `@UncleTalik/sheetsdb-client` package and deploys to GitHub Pages.
Repo A (this one) publishes the package. Repo B installs it.

> The in-repo `example/` app in Repo A dogfoods the client via an npm
> workspace link and does **not** need any of this — it's strictly for a
> downstream consumer.

## Why you need a PAT (the built-in `GITHUB_TOKEN` is not enough)

GitHub Actions gives each workflow a `GITHUB_TOKEN` automatically, but by
default that token can only read packages from the **same repo** that's
running the workflow. Repo B needs to install a package published from Repo
A — a different repo — so the built-in token won't work. You need a
**Personal Access Token** with `read:packages`, stored as a repo secret.

## One-time setup

### 1. Create an install PAT

At <https://github.com/settings/tokens>, create a **classic** PAT with scope
`read:packages` only. Call it `sheetsdb-install`. Copy the token — you'll
only see it once.

### 2. Add the PAT as a secret in Repo B

Repo B on GitHub → **Settings → Secrets and variables → Actions → New
repository secret**:

- **Name**: `PACKAGES_TOKEN`
- **Value**: the PAT from step 1

### 3. Add the PAT to your local shell

For local development and builds, add to `~/.zshrc` or `~/.bashrc`:

```bash
export GITHUB_PACKAGES_TOKEN=ghp_your_token_here
```

Reload your shell.

## Repo B files

### `.npmrc` (commit this — no secrets in it)

```
@UncleTalik:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

`${GITHUB_PACKAGES_TOKEN}` is a literal — npm substitutes it from the
environment at install time. The distinct name avoids collision with GitHub
Actions' built-in `GITHUB_TOKEN`.

### Install the package

```bash
npm install @UncleTalik/sheetsdb-client
```

### Use it

```ts
import { createClient } from "@UncleTalik/sheetsdb-client";

const db = createClient({
  webAppUrl: import.meta.env.VITE_SHEETSDB_URL,
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
});
```

Don't forget the GIS script tag in `index.html`:

```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
```

### `.github/workflows/deploy.yml`

Deploys to GitHub Pages on push to `main`:

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: 'https://npm.pkg.github.com'
          scope: '@UncleTalik'

      - name: Install dependencies
        run: npm ci
        env:
          GITHUB_PACKAGES_TOKEN: ${{ secrets.PACKAGES_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.PACKAGES_TOKEN }}

      - name: Build
        run: npm run build
        env:
          VITE_SHEETSDB_URL: ${{ secrets.SHEETSDB_URL }}
          VITE_GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}

      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist
      - id: deployment
        uses: actions/deploy-pages@v4
```

The PAT maps to both `GITHUB_PACKAGES_TOKEN` (for `.npmrc` substitution) and
`NODE_AUTH_TOKEN` (which `actions/setup-node` wires up automatically).

### Repo B secrets summary

| Secret              | Purpose |
|---------------------|---------|
| `PACKAGES_TOKEN`    | PAT with `read:packages`. Build-time only, never reaches the browser. |
| `SHEETSDB_URL`      | Your Apps Script `/exec` URL. Inlined into the bundle at build time. |
| `GOOGLE_CLIENT_ID`  | OAuth client ID. Inlined into the bundle at build time. |

Neither `SHEETSDB_URL` nor `GOOGLE_CLIENT_ID` is actually secret — the URL is
public and OAuth client IDs are designed to be public — but keeping them in
repo secrets lets you rotate cleanly.

## What lives where

| Where                  | What                        | Why |
|------------------------|-----------------------------|-----|
| Repo A (`sheets-db`)   | Apps Script, client source, publishes package | Source of truth. |
| Repo B (your webapp)   | Consumes `@UncleTalik/sheetsdb-client`, deploys to Pages | The thing your users open. |
| Repo B secrets         | `PACKAGES_TOKEN`            | npm install in CI. |
| Repo B secrets         | `SHEETSDB_URL`, `GOOGLE_CLIENT_ID` | Inlined at build time. |
| Your shell             | `GITHUB_PACKAGES_TOKEN`     | Same PAT, for local dev. |
| `_allowlist` sheet     | User emails                 | Runtime auth — who can use the app. |

**Package access and app access are independent.** The PAT controls "who can
install the library." The `_allowlist` sheet controls "who can use the
deployed app." Only you need the PAT. Your users only need to be on the
allowlist.

## The gotcha

GitHub Packages **does not support unauthenticated installs**, even for
public repos. Every consumer needs a token. If you want fully open installs,
publish to the public npm registry instead.
