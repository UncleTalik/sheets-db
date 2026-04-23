# example — expense tracker (SheetsDB dogfood)

A minimal Vite + TypeScript app that consumes `@UncleTalik/sheetsdb-client`
through an npm workspace link. Every change to the client is exercised here
before we ship.

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

Open <http://localhost:5173>, sign in with an allowlisted Google account, and
add an expense. Refresh — the row should still be there. Open the Sheet in
another tab and confirm the row was written with an auto-generated `id` and
`createdAt`.

## What this exercises

- `signIn()` — Google Identity Services popup.
- `db.table<Expense>("expenses").select()` — read with type narrowing.
- `db.table<Expense>("expenses").insert(...)` — write with validation + defaults.
- `db.table<Expense>("expenses").delete(id)` — delete.
- Error display — `SheetsDBError.code` and `details` surface the backend
  error codes (`validation`, `unauthorized`, etc.).
