# example — expense tracker (SheetsDB dogfood)

A minimal Vite + TypeScript app that consumes `@UncleTalik/sheetsdb-client`
through an npm workspace link. Every change to the client is exercised here
before we ship.

**Live demo**: <https://uncletalik.github.io/sheets-db/> (deployed from `main`
by [`.github/workflows/deploy-example.yml`](../.github/workflows/deploy-example.yml)).
Setup runbook in the [root README](../README.md#live-demo-deploying-the-example-to-github-pages).

## Prerequisites

You need a deployed Apps Script backend (see [`../docs/setup.md`](../docs/setup.md))
and an OAuth 2.0 Client ID with this origin (`http://localhost:5173`) added to
**Authorized JavaScript origins**.

## Run locally

From the repo root:

```bash
npm install
npm run build --workspace client
cp example/.env.example example/.env.local
# edit example/.env.local and fill in VITE_SHEETSDB_URL + VITE_GOOGLE_CLIENT_ID
npm run dev --workspace example
```

Open <http://localhost:5173>, sign in with an allowlisted Google account.

**First run only**: if the `expenses` sheet doesn't exist yet, the app
catches the `not_found` error and shows a *"Create expenses table"*
button. Clicking it calls `db.provision({ tables: { expenses: [...] } })`
to create the sheet and its `_meta` rows. Requires the `OWNER_EMAIL`
Script Property to match your signed-in account.

After that, add an expense. Refresh — the row should still be there. Open
the Sheet in another tab and confirm the row was written with an
auto-generated `id` and `createdAt`.

## DevTools handle

In `npm run dev`, `db` is exposed on `window` for console tinkering:

```js
await db.schema()
await db.table("expenses").where({ category: "groceries" }).select()
```

The `window` exposure is gated by `import.meta.env.DEV`, so production
builds don't carry it.

## What this exercises

- `signIn()` — Google Identity Services popup.
- `db.provision(...)` — declarative first-run table creation.
- `db.table<Expense>("expenses").select()` — read with type narrowing.
- `db.table<Expense>("expenses").insert(...)` — write with validation + defaults.
- `db.table<Expense>("expenses").delete(id)` — delete.
- Error display — `SheetsDBError.code` and `details` surface the backend
  error codes (`validation`, `unauthorized`, `not_found`, etc.).
- First-run UX — the `not_found` branch shows an inline setup button
  instead of a red error toast.
