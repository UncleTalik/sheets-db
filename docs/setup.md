# Backend setup — deep reference

The happy-path setup lives in the [root README](../README.md#getting-started).
This document covers the same steps with more context, plus troubleshooting.

## What each Apps Script file does

| File | Purpose | Called by |
|---|---|---|
| `Main.gs` | `doPost` entry + RPC dispatch + `withLock` helper | Web app |
| `Auth.gs` | Verifies the Google ID token and checks `_allowlist` | `dispatch` |
| `Schema.gs` | Reads `_meta`, validates + coerces row values | `insert`, `update` |
| `Table.gs` | CRUD helpers against data sheets | `dispatch` |
| `Provision.gs` | Creates tables and populates `_meta`/`_allowlist` from a declarative spec | `dispatch` (op: `provision`) |
| `Bootstrap.gs` | One-time `bootstrap()` runner — creates `_meta` and `_allowlist` sheets | You (from the editor) |
| `Test.gs` | `runSmokeTest` — CRUD sanity check that bypasses auth | You (from the editor) |

Reads (`select`, `schema`) skip the script lock; mutations
(`insert`/`update`/`delete`/`provision`) acquire it with a 10 s timeout.

## OAuth scopes (what Google asks you to authorize)

The manifest requests two scopes — both deliberately minimal:

| Scope | Google's consent-screen label | Why we need it |
|---|---|---|
| `spreadsheets.currentonly` | *"See, edit, create, and delete this spreadsheet only"* | CRUD on the single container spreadsheet — **not** your other sheets. |
| `script.external_request` | *"Connect to an external service"* | One outbound HTTPS call to `oauth2.googleapis.com/tokeninfo` to verify Google ID tokens. No user data leaves the script. |

`spreadsheets.currentonly` only works because this is a **container-bound**
script (you opened the editor via Extensions → Apps Script on the sheet).
If you ever move the script to a standalone project, you'd have to switch
to the broader `spreadsheets` scope and pair it with `openById()` — don't
do that unless you need it.

If you change the manifest, Apps Script forces you to re-authorize on the
next run or redeploy. You can revoke the old authorization at
<https://myaccount.google.com/permissions>.

## Script properties

Set under **Project Settings (⚙) → Script properties**.

| Property | Required for | Value |
|---|---|---|
| `OAUTH_CLIENT_ID` | every request | OAuth 2.0 Client ID (ends in `.apps.googleusercontent.com`) |
| `OWNER_EMAIL` | `db.provision()` | single admin email; non-matching callers get `unauthorized` |

`OWNER_EMAIL` is optional at first — you can skip it if you only want to
manage `_meta` by hand. But if any call to `provision` comes in without it
set, the backend responds `misconfigured`.

## One GCP project per app

Create a **new Google Cloud project for each SheetsDB-backed app** (e.g.
`family-expenses`, `chores-tracker`) rather than reusing one generic
`sheetsdb` project across all of them. The consent screen is configured
per-project and is what every signed-in user sees — matching app name +
logo + support email to the actual app is worth the 5-minute cost of a
new project. You also get:

- **Independent verification status.** If one app ever outgrows Testing
  mode and needs Google's verification, it doesn't entangle the others.
- **Independent test-user list.** Each app's testers match that app's
  audience.
- **Clean isolation.** Deleting a project cleanly nukes one app's OAuth
  without touching anything else.

Each SheetsDB app already has its own spreadsheet + Apps Script + `OAUTH_CLIENT_ID`
script property. Project-per-app keeps that mental model symmetric.

## OAuth consent screen

First time in each project. In Google Cloud Console → **APIs & Services
→ OAuth consent screen**:

- **User type**: External.
- **App name**: the **actual app name users will see on the consent
  prompt** (e.g. `Family Expenses`) — not `sheetsdb`.
- **User support email**: yours.
- **Developer contact**: yours.
- **Scopes**: none beyond the default (Google Identity gives us email +
  profile for free).
- **Test users**: add everyone who will sign in while the app is in "Testing"
  mode. Apps in Testing can only be used by listed test users; to remove the
  restriction you'd need to publish, which requires going through Google's
  verification — usually overkill for a private app.

## Authorized JavaScript origins

On the OAuth client ID, **Authorized JavaScript origins** must list every
origin your frontend will run from. Common ones:

- `http://localhost:5173` (Vite dev server)
- `http://localhost:3000` (Next.js / CRA dev)
- `https://<user>.github.io`
- `https://<your-custom-domain>`

Missing an origin → the GIS popup silently fails and the library throws
`unauthorized: sign-in prompt dismissed: unregistered_origin`.

## Deploying and updating

**First deploy**: **Deploy → New deployment → ⚙ → Web app → Execute as: Me,
Who has access: Anyone.** Copy the `/exec` URL.

**Updating the code**: **Deploy → Manage deployments → ✎ (edit the existing
one) → Version: New version → Deploy.** Editing (not creating a new
deployment) keeps the `/exec` URL stable.

If you ever create a *new* deployment (vs. editing the existing one), the
URL changes and every consumer has to be updated.

## Running `bootstrap()` and `runSmokeTest`

Both are editor-only — they bypass auth. Select the function from the
dropdown, click **Run ▶**, check the execution log.

- `bootstrap()` — creates `_meta` and `_allowlist` with header rows. Seeds
  `_allowlist` with `Session.getActiveUser().getEmail()` if available.
  Idempotent.
- `runSmokeTest()` — inserts → selects → updates → removes a row in the
  `expenses` table. Assumes the table already exists (so run `provision`
  first, or create the sheet manually).

## Troubleshooting

**`unauthorized: missing idToken`** — your frontend didn't call `db.signIn()`
before making a request, or the token was cleared (reload → must sign in
again; tokens are in-memory only).

**`unauthorized: audience mismatch`** — the OAuth Client ID in your frontend
doesn't match `OAUTH_CLIENT_ID` in Script Properties. They must be the same
string.

**`unauthorized: not in allowlist: x@example.com`** — add the email to
`_allowlist` (row, column A) or call `db.provision({ allowlist: [...] })`.

**`misconfigured: OAUTH_CLIENT_ID script property not set`** — step 5 was
skipped.

**`misconfigured: _meta sheet missing` / `_allowlist sheet missing`** — run
`bootstrap()` from the editor.

**`misconfigured: OWNER_EMAIL script property is not set`** — you called
`provision` but haven't set `OWNER_EMAIL`. Set it in Script Properties.

**`not_found: no such sheet: <table>`** — the table was deleted or never
created. Re-run `provision` with its schema.

**`busy: could not acquire lock`** — another mutation is in flight and took
longer than 10 s. Usually transient; retry.

**Requests time out silently** — Apps Script responds to cross-origin POSTs
with a 302 redirect to `googleusercontent.com`. Browsers follow it
automatically, but some corporate proxies strip the redirect. The client
sets `redirect: "follow"` explicitly; if you've wrapped fetch, make sure
you haven't overridden it.

## Adding a column to an existing table

Two ways:

**Via `provision` (recommended)**:

```ts
await db.provision({
  tables: {
    expenses: [
      { column: "id",        type: "string",   required: true, unique: true, default: "auto" },
      // ...all existing columns...
      { column: "paymentMethod", type: "enum:cash|card", required: false },  // NEW
    ],
  },
});
```

The backend appends the new column to the sheet's header row and adds a
`_meta` row for it. Existing rows get an empty cell for the new column — so
keep the new column `required: false` (or set a `default`), otherwise every
`update` will fail validation until you backfill.

**Manually**: edit the sheet header row and add a row to `_meta`. Both must
list the new column in the same position the sheet assigns it.

## Removing data, tables, or allowlist entries

`provision` is additive only by design. To remove things:

- **Delete a row**: `db.table("x").delete(id)` (normal op).
- **Clear a table**: select all and delete each row — or wipe the sheet in
  the spreadsheet UI.
- **Drop a table**: right-click the sheet tab → Delete. Then remove the
  `_meta` rows for it by hand.
- **Remove an allowlist entry**: delete the row from `_allowlist` by hand.

These are rare enough that hand-editing the sheet is fine.
