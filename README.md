# sheets-db

Turn a Google Spreadsheet into a typed, validated row store your browser app
can call over the network — with Google Sign-In for auth, a declarative
schema, and no servers to manage.

- **Free.** Runs on Google Apps Script + a Google Sheet you already own.
- **Private.** Per-user allowlist. Only emails you add can read or write.
- **Typed.** TypeScript client with `db.table<Expense>("expenses").select()`.
- **Self-provisioning.** Define your schema in code; call `db.provision(...)`
  once and the backend creates the sheets and `_meta` rows for you.
- **Zero runtime deps.** The client is ~5 KB gzipped.

## Is this for you?

| Good fit | Not a good fit |
|---|---|
| Family apps, internal tools, side projects | Public-facing apps with thousands of users |
| ≤ a few hundred ops/day | High write throughput (the Sheets API is slow) |
| Simple equality filters, lookup by id | Complex joins, aggregates, transactions |
| You want your data in a spreadsheet you can open | You need strict schema migrations or replication |

Rough performance ceiling: ~500ms-1s per request (Sheets API latency). Plan
for a few hundred ops/day, not a few hundred ops/minute.

---

## Getting started

Fifteen to twenty minutes end-to-end. You will:

1. Create a Google Spreadsheet (1 min)
2. Paste the Apps Script files (2 min)
3. Run `bootstrap()` to create the infrastructure sheets (30 sec)
4. Create a Google OAuth client ID (5 min)
5. Set two Script Properties (1 min)
6. Deploy as a Web App and copy the URL (2 min)
7. Install the client in your app (2 min)
8. Call `db.provision()` once to define your tables (1 min)
9. Use `db.table(...)` for CRUD (ongoing)

The Apps Script side is in `apps-script/`. The client is
`@UncleTalik/sheetsdb-client`, published to GitHub Packages.

### 1. Create the Spreadsheet

Open <https://sheets.new>. Rename it (e.g. `my-app-db`). That's it — don't
add any sheets yet. `bootstrap()` will do that in step 3.

### 2. Paste the Apps Script files

In the spreadsheet: **Extensions → Apps Script**. Delete the default
`Code.gs` stub. Then, for each file in this repo's [`apps-script/`](./apps-script)
directory, click **+ → Script** in the editor and paste:

- `Main.gs` — entry point + RPC dispatch
- `Auth.gs` — ID token verification + allowlist
- `Schema.gs` — `_meta` reader + row validation
- `Table.gs` — CRUD helpers
- `Provision.gs` — `db.provision()` implementation
- `Bootstrap.gs` — the one-time `bootstrap()` runner
- `Test.gs` — manual smoke test

Then click the **⚙ Project Settings** gear → "Show 'appsscript.json' manifest
file in editor", and replace its contents with
[`apps-script/appsscript.json`](./apps-script/appsscript.json).

### 3. Run `bootstrap()`

In the editor, select the `bootstrap` function from the dropdown and click
**Run ▶**. Authorize the requested scopes when prompted. The execution log
should print:

```
Bootstrap results:
  • created _meta
  • created _allowlist and seeded with your.email@gmail.com
```

Open the spreadsheet and confirm the `_meta` and `_allowlist` sheets now
exist. Your email is already in the allowlist.

### 4. Create an OAuth 2.0 Client ID

<https://console.cloud.google.com/apis/credentials>:

1. **Create a new Google Cloud project for this app** — one project per
   SheetsDB-backed app, named after the app (e.g. `family-expenses`, not
   a generic `sheetsdb`). Don't reuse an existing project.

   Why a dedicated project: the OAuth **consent screen** (app name, logo,
   support email, verification status, test-user list) is configured once
   per project and is what every signed-in user sees when they grant
   access. Sharing one project across apps means users see a generic name
   instead of the app they're signing into, all your apps get entangled
   under one verification status, and a problem with one app affects all
   the others. Each SheetsDB app already has its own spreadsheet + Apps
   Script + `OAUTH_CLIENT_ID` — keeping the GCP project per-app keeps
   that boundary symmetric. The only cost is ~5 minutes to fill in the
   consent screen.

2. Configure the **OAuth consent screen** (first time in this project):
   User type *External*, **app name = the actual app name** (the one
   users will see on the Google prompt, e.g. `Family Expenses`), user
   support email = yours. Add every email that will sign in under "Test
   users" — while the app is in Testing mode, only listed test users can
   get past the Google consent prompt.
3. **Credentials → Create Credentials → OAuth client ID → Web application**.
4. Under **Authorized JavaScript origins**, add where your frontend will run:
   - Local dev: `http://localhost:5173`
   - GitHub Pages: `https://<your-github-username>.github.io`
5. Click **Create**. Copy the **Client ID** (ends in
   `.apps.googleusercontent.com`).

### 5. Set Script Properties

Back in the Apps Script editor: **Project Settings (⚙) → Script properties →
Add script property**. Add two:

| Property | Value | Required for |
|---|---|---|
| `OAUTH_CLIENT_ID` | the Client ID from step 4 | every request |
| `OWNER_EMAIL` | your Google account email | `db.provision()` calls |

`OWNER_EMAIL` gates `provision` to a single admin — other allowlisted users
can read/write but can't reshape the schema.

### 6. Deploy as a Web App

In the editor: **Deploy → New deployment → ⚙ → Web app**:

- **Execute as**: *Me*
- **Who has access**: *Anyone* — **not** *Anyone with a Google account*. This matters. See below.

Click **Deploy** and authorize. Copy the **Web app URL** (ends in `/exec`).

> ⚠️ **Anyone vs. Anyone with a Google account** — these look similar in the
> dropdown and are the most common way to get stuck.
>
> | Setting | What actually happens |
> |---|---|
> | **Only myself** | Only the deployer can reach the endpoint. |
> | **Anyone with a Google account** | Google enforces a session-cookie check before your code runs. Browsers don't send cookies with cross-origin `fetch`, so every request from your frontend fails with a 401 + **no CORS headers** — symptoms include `Access to fetch at ... has been blocked by CORS policy`. |
> | **Anyone** ← pick this | Unauthenticated HTTP is allowed to reach `doPost`. The script itself verifies the Google ID token and checks `_allowlist` — that's the real auth. |
>
> "Anyone" sounds alarming but is exactly what SheetsDB is designed around.
> Your data is protected by the `_allowlist` + ID token verification *inside*
> the script. Google can't enforce cookie-based auth for cross-origin
> browser calls, so we do it at the app layer instead.

### 7. Install the client in your app

The package is on GitHub Packages (private registry). You need a token to
install it.

Create a classic PAT at <https://github.com/settings/tokens> with scope
`read:packages`. In your app's shell:

```bash
export GITHUB_PACKAGES_TOKEN=ghp_your_token_here   # add to ~/.zshrc
```

Commit this `.npmrc` in your app repo (no secrets in it — the token comes
from the env):

```
@UncleTalik:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Install:

```bash
npm install @UncleTalik/sheetsdb-client
```

And add this to your `index.html` — GIS is not bundled:

```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
```

### 8. Sign in and provision your schema

```ts
import { createClient } from "@UncleTalik/sheetsdb-client";

const db = createClient({
  webAppUrl: import.meta.env.VITE_SHEETSDB_URL,         // from step 6
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID, // from step 4
});

await db.signIn();

await db.provision({
  tables: {
    expenses: [
      { column: "id",        type: "string",   required: true, unique: true, default: "auto" },
      { column: "createdAt", type: "datetime", required: true, default: "now" },
      { column: "amount",    type: "number",   required: true },
      { column: "category",  type: "string",   required: true },
      { column: "note",      type: "string" },
    ],
  },
  allowlist: ["partner@example.com"],   // optional: add more users
});
```

Call `provision` from a one-off admin page or the browser console — you
don't need it on every app load. It's idempotent: running it twice is fine.
Existing tables, columns, and allowlist entries are never overwritten or
removed.

The supported types are `string`, `number`, `boolean`, `datetime`, and
`enum:a|b|c`. Special defaults: `auto` (required on the `id` column —
generates short IDs like `exp_k3j8f2a1bc`) and `now` (ISO timestamp).

### 9. Use it

```ts
interface Expense {
  id: string;
  createdAt: string;
  amount: number;
  category: string;
  note?: string;
}

const list = await db.table<Expense>("expenses")
  .where({ category: "groceries" })
  .select();

const created = await db.table<Expense>("expenses").insert({
  amount: 42.5,
  category: "groceries",
  note: "milk",
});

await db.table<Expense>("expenses").update(created.id, { amount: 43 });
await db.table<Expense>("expenses").delete(created.id);
```

Errors surface as `SheetsDBError` with a `code` and `details`:

```ts
import { SheetsDBError } from "@UncleTalik/sheetsdb-client";

try {
  await db.table("expenses").insert({ amount: "not-a-number" });
} catch (err) {
  if (err instanceof SheetsDBError) {
    console.log(err.code, err.details);
    // "validation", "amount must be a number"
  }
}
```

Error codes: `unauthorized`, `validation`, `not_found`, `bad_request`,
`busy`, `misconfigured`, `internal`.

## System tables

Sheet names that start with `_` are reserved for SheetsDB's own
infrastructure — currently `_meta` (schema registry) and `_allowlist`
(per-user access). These are **not reachable through the RPC API**:
`select`, `insert`, `update`, and `delete` against any `_*` table return
`unauthorized` for every caller, including the owner. Manage them in
the spreadsheet UI directly. `provision` (owner-only) is the one
documented exception — it writes `_meta` and `_allowlist` as part of
declarative setup, and rejects user-supplied `spec.tables` keys that
start with `_`.

The leading-underscore rule is forward-compatible: any future system
table (e.g. `_audit`, `_settings`) is auto-protected — don't name your
own tables with a leading underscore.

---

## Going deeper

- [Apps Script reference implementation](./apps-script) — the backend code.
- [`client/README.md`](./client/README.md) — full client API reference.
- [`docs/setup.md`](./docs/setup.md) — backend troubleshooting & advanced setup.
- [`docs/schema.md`](./docs/schema.md) — `_meta` schema reference (types, defaults).
- [`docs/consumer-setup.md`](./docs/consumer-setup.md) — deploying a webapp to
  GitHub Pages that consumes the package.
- [`docs/specs/sheets-db-design-spec.md`](./docs/specs/sheets-db-design-spec.md)
  — architecture + RPC protocol.

## Working on this repo

This is a monorepo using npm workspaces:

| Path | What |
|---|---|
| [`apps-script/`](./apps-script) | Backend (pasted into Apps Script editor). |
| [`client/`](./client) | `@UncleTalik/sheetsdb-client` TypeScript source + tests. |
| [`example/`](./example) | Dogfood expense-tracker app — uses the local client via a workspace link. |

```bash
npm install
npm run test --workspace client    # unit tests
npm run build --workspace client   # ESM + CJS + dts
npm run dev --workspace example    # local expense tracker (needs .env.local)
```

The example app is the primary integration test — every client change is
exercised against a real deployed backend before a release goes out.

## Live demo: deploying the example to GitHub Pages

A GitHub Actions workflow at
[`.github/workflows/deploy-example.yml`](./.github/workflows/deploy-example.yml)
publishes the example app to GitHub Pages on every push to `main` that
touches `client/`, `example/`, or the workspace root. Once configured, the
app is available at **<https://uncletalik.github.io/sheets-db/>**.

### One-time setup (required before the first deploy)

The workflow will fail until you do all three:

**1. Add repo secrets.** Settings → Secrets and variables → Actions → **New
repository secret**:

| Name | Value |
|---|---|
| `SHEETSDB_URL` | your Apps Script `/exec` URL |
| `GOOGLE_CLIENT_ID` | your OAuth 2.0 Client ID |

Neither is actually secret (the web-app URL is public, OAuth client IDs
are designed to be public) — using repo secrets just makes rotation
clean. They're inlined into the bundle at build time, never sent to the
browser as runtime state.

**2. Enable Pages.** Settings → Pages → **Source: GitHub Actions**.
Don't pick "Deploy from a branch" — that's a different deploy mode and
won't work with this workflow.

**3. Add the Pages origin to Google OAuth.**
<https://console.cloud.google.com/apis/credentials> → edit your OAuth
client ID → **Authorized JavaScript origins** → add
`https://uncletalik.github.io`. Without this the GIS sign-in popup
refuses to open on the deployed site (silent failure).

Note: the origin is just scheme + host, **not** the `/sheets-db/` path.
If you later deploy more SheetsDB apps to other `github.io/<repo>/`
paths, one origin covers all of them.

### Running the workflow

Any push to `main` that touches the watched paths triggers it. You can
also trigger it by hand: **Actions → Deploy example to GitHub Pages →
Run workflow**.

### How the build works

1. `npm ci` resolves the workspace link for the client package.
2. `npm run build --workspace client` produces `client/dist/` (gitignored,
   not present in CI).
3. `npm run build --workspace example` inlines the two env vars and
   prefixes asset URLs with `/sheets-db/` (Pages serves from
   `https://<user>.github.io/<repo>/`, so asset paths need the repo name).
4. `example/dist` is uploaded as a Pages artifact and deployed.

The `base: "/sheets-db/"` setting lives in
[`example/vite.config.ts`](./example/vite.config.ts) and only applies to
production builds — `npm run dev --workspace example` still serves at
`http://localhost:5173/`.

## Publishing

The client is published to GitHub Packages **automatically on every push
to `main` that bumps the `version` field in
[`client/package.json`](./client/package.json)**. No tags, no CLI dance.

To cut a release:

1. In a PR (or a follow-up commit on `main`), change the `version` field in
   `client/package.json` — e.g. `0.1.0` → `0.1.1` for a patch, `0.2.0` for
   a minor, `1.0.0` for a major. Pick the bump based on what actually
   changed, not a schedule.
2. Merge.
3. The [`publish.yml`](./.github/workflows/publish.yml) workflow fires,
   checks whether that exact version is already on GitHub Packages (skips
   if so), then typechecks, tests, builds, and publishes.

Doc-only or non-version PRs don't trigger a publish — the path filter is
scoped to `client/package.json`.

If you need to re-run a publish manually (e.g. you hand-rolled something
else and just want to try again), trigger the workflow from the Actions
tab via **Run workflow** — same logic, same idempotency check.

Version rule: **the client's major version must match the backend's major
version.** Bump both together if you ever change the RPC wire format.

## License

MIT
