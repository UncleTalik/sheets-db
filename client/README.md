# @UncleTalik/sheetsdb-client

Typed TypeScript client for the [SheetsDB](https://github.com/UncleTalik/sheets-db)
Apps Script backend. Turns a Google Spreadsheet into a tiny key-value/row store
accessible from any browser app via Google Sign-In.

```ts
import { createClient } from "@UncleTalik/sheetsdb-client";

const db = createClient({
  webAppUrl: import.meta.env.VITE_SHEETSDB_URL,
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
});

await db.signIn();
const rows = await db.table("expenses")
  .where({ category: "groceries", amount: { gte: 5, lte: 50 } })
  .select();
```

## Install

This package is published to **GitHub Packages** (private). You need a token to
install it, even if the repo is public — GitHub Packages is always token-gated.

**1. Create a PAT** at <https://github.com/settings/tokens> with the scope
`read:packages`. Call it `sheetsdb-install`.

**2. In your consuming app, commit this `.npmrc`:**

```
@UncleTalik:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

The `${GITHUB_PACKAGES_TOKEN}` is a literal — npm substitutes it from the
environment at install time. Using a distinct name avoids collision with
GitHub Actions' built-in `GITHUB_TOKEN`.

**3. Set the env var locally:**

```bash
export GITHUB_PACKAGES_TOKEN=ghp_your_token_here
```

**4. Install:**

```bash
npm install @UncleTalik/sheetsdb-client
```

**5. Include the Google Identity Services script tag in your `index.html`** — it
is not bundled by the library:

```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
```

## Prerequisites

You need a deployed SheetsDB Apps Script backend. See the
[setup runbook](https://github.com/UncleTalik/sheets-db/blob/main/docs/setup.md)
for the one-time backend deployment steps.

## API

### `createClient(config)`

```ts
createClient({
  webAppUrl: string;        // your Apps Script /exec URL
  googleClientId: string;   // OAuth 2.0 Client ID from Google Cloud Console
}): SheetsDB
```

### `SheetsDB`

```ts
interface SheetsDB {
  signIn(): Promise<User>;                          // Google popup; stores JWT in memory
  signOut(): void;                                  // clears token
  currentUser(): User | null;
  table<T>(name: string): TableQuery<T>;
  schema(): Promise<Schema>;
  provision(spec: ProvisionSpec): Promise<ProvisionResult>;  // declarative schema setup
}

interface User { email: string; name: string }
```

### `TableQuery<T>`

```ts
interface TableQuery<T> {
  where(filter: Where): TableQuery<T>;              // immutable; returns a new query
  select(): Promise<T[]>;
  selectOne(): Promise<T | null>;
  insert(row: Partial<T>): Promise<T>;              // server applies defaults
  update(id: string, patch: Partial<T>): Promise<T>;
  delete(id: string): Promise<{ id: string }>;
}

type WherePrimitive = string | number | boolean;

interface WhereOperators {
  eq?:  WherePrimitive;
  ne?:  WherePrimitive;
  gt?:  WherePrimitive;
  gte?: WherePrimitive;
  lt?:  WherePrimitive;
  lte?: WherePrimitive;
  like?: string;             // % matches any sequence, _ matches one char
  in?:  WherePrimitive[];
  nin?: WherePrimitive[];
}

type Where = Record<string, WherePrimitive | WhereOperators>;
```

Each field in `where` is either a primitive (equality shorthand) or an
operator object. Multiple operators on one field combine with AND; multiple
fields combine with AND. Comparisons are type-aware — `number` columns use
numeric ordering, `datetime` columns use ISO-string ordering (chronological
because storage is `.toISOString()`), everything else is lexicographic.

```ts
// equality shorthand (same as { eq: "groceries" })
await db.table("expenses").where({ category: "groceries" }).select();

// range
await db.table("expenses").where({ amount: { gte: 5, lte: 50 } }).select();

// like (use % and _ wildcards; bounded to 256 chars / 8 wildcards)
await db.table("expenses").where({ note: { like: "%coffee%" } }).select();

// in / nin
await db.table("expenses").where({ category: { in: ["groceries", "gas"] } }).select();
await db.table("expenses").where({ category: { nin: ["rent"] } }).select();
```

Chained `.where()` calls AND across fields and **replace** clauses on the
same field — combine multiple operators on one field in a single call:

```ts
// drops { gt: 5 }; only { lt: 10 } survives
await db.table("expenses").where({ amount: { gt: 5 } }).where({ amount: { lt: 10 } }).select();

// correct
await db.table("expenses").where({ amount: { gt: 5, lt: 10 } }).select();
```

The backend reads the entire sheet and filters in JavaScript — performance
is bounded by row count, not by selectivity. Keep tables small or filter
further in memory.

## `provision` — declarative schema setup

Declare your tables in code and let the backend create the sheets and `_meta`
rows. Additive only — never drops tables, columns, or allowlist entries.

```ts
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
  allowlist: ["partner@example.com"],
});
```

Returns:

```ts
interface ProvisionResult {
  tablesCreated: string[];
  tablesSkipped: string[];                 // already existed
  columnsAdded: Record<string, string[]>;  // table → new columns (when a sheet existed but was missing columns)
  allowlistAdded: string[];                // emails that weren't already there
}
```

Column spec:

```ts
interface ColumnSpec {
  column: string;
  type: "string" | "number" | "boolean" | "datetime" | `enum:${string}`;
  required?: boolean;   // default false
  unique?: boolean;     // default false
  default?: string | null;  // "auto" (id only), "now", or any literal
}
```

Every table must declare an `id` column (type `string`, `unique: true`,
`default: "auto"`) — `update` and `delete` rely on it. You'll get a
`validation` error if you forget.

**Authorization.** `provision` is gated to a single admin identified by the
`OWNER_EMAIL` Apps Script property. Other allowlisted users can read/write
but can't reshape the schema. If `OWNER_EMAIL` is unset, all `provision`
calls fail with `misconfigured`.

**When to call it.** Usually once, from an admin page or the browser
console — not on every app load. It's idempotent, but it does round-trip
through Apps Script (~1 second).

## Typed tables

Pass a type parameter to narrow the return type:

```ts
interface Expense {
  id: string;
  createdAt: string;
  amount: number;
  category: string;
  note?: string;
}

const rows: Expense[] = await db.table<Expense>("expenses").select();
```

## Error handling

All backend errors arrive as a `SheetsDBError` with a `code` and optional
`details`:

```ts
import { SheetsDBError } from "@UncleTalik/sheetsdb-client";

try {
  await db.table("expenses").insert({ amount: "not a number" });
} catch (err) {
  if (err instanceof SheetsDBError) {
    console.log(err.code, err.details);
    // code: "validation", details: "amount must be a number"
  }
}
```

Error codes:

| code             | meaning |
|------------------|---------|
| `unauthorized`   | No valid ID token, audience mismatch, email not verified, not in allowlist, **or attempt to access a reserved system table** (any name starting with `_`, e.g. `_meta`, `_allowlist`). |
| `validation`     | Row failed schema validation (missing required, bad type, duplicate unique). |
| `not_found`      | Table or row with given `id` does not exist. |
| `bad_request`    | Request body missing a required field. |
| `bad_op`         | Unknown `op` value. |
| `busy`           | Could not acquire the script lock within 10s. |
| `misconfigured`  | Backend is missing a sheet or script property. Tell the admin. |
| `internal`       | Something else blew up. Check the Apps Script execution log. |

## Token lifetime

The Google ID token is **stored in memory only** — never in `localStorage` or
`sessionStorage`. Tokens are short-lived (~1 hour), so users must sign in again
after a page reload. This is intentional: it keeps the attack surface small.

## Zero runtime dependencies

This package has no runtime dependencies. It uses the built-in `fetch` API and
loads Google Identity Services from `https://accounts.google.com/gsi/client` at
runtime (via the script tag you include in your HTML).

## Migration: upgrading from 0.3.x

`0.4.0` widens the `Where` type to accept operator clauses
(`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`like`/`in`/`nin`) alongside the existing
primitive-equality shorthand. The matching backend version is `1.2.0`.

**Client side:**

1. Bump the dependency:
   ```bash
   npm install @UncleTalik/sheetsdb-client@^0.4.0
   ```
2. No code changes required. Existing `.where({ category: "groceries" })`
   calls keep working as equality shorthand.
3. Optionally adopt operator clauses where in-memory filtering used to be
   needed:
   ```ts
   // before: select all then filter
   const rows = await db.table("expenses").select();
   const big = rows.filter(r => r.amount >= 50);

   // after
   const big = await db.table("expenses").where({ amount: { gte: 50 } }).select();
   ```

**Wire format is unchanged** — operator clauses are nested objects on the
existing `where` field. A new client talks to a `1.1.0` backend just fine
**as long as you stick to primitive shorthand**. Operator clauses only
work against `1.2.0+`; older backends will fall back to comparing the
serialized object via `String(...)` and silently match nothing.

**Compatibility matrix:**

| Client    | Backend   | Operator clauses             | Primitive shorthand          |
|-----------|-----------|------------------------------|------------------------------|
| `0.3.x`   | `1.1.0`   | n/a                          | works                        |
| `0.3.x`   | `1.2.0`   | n/a                          | works                        |
| `0.4.0`   | `1.1.0`   | silently match nothing       | works                        |
| `0.4.0`   | `1.2.0`   | works                        | works                        |

**Backend side** (the spreadsheet/Apps Script owner): see
[docs/setup.md → Upgrading the backend](https://github.com/UncleTalik/sheets-db/blob/main/docs/setup.md#upgrading-the-backend-110--120).

## Migration: upgrading from 0.2.x

`0.3.0` adds a guard that refuses RPC access to **system tables** —
any sheet whose name starts with `_` (today: `_meta` and `_allowlist`).
The backend matches this by rejecting the same calls with `unauthorized`
(backend version `1.1.0`).

**Client side:**

1. Bump the dependency:
   ```bash
   npm install @UncleTalik/sheetsdb-client@^0.3.0
   ```
2. Search your codebase for `.table("_meta")` and `.table("_allowlist")`
   (and any `_*` literals). Remove those calls — they now throw
   `SheetsDBError({ code: "unauthorized" })` before any network round-trip.
   The owner manages those sheets in the spreadsheet UI directly.
3. No other API changes. Existing user-table calls (`expenses`, etc.)
   work unchanged.

**Backend side** (the spreadsheet/Apps Script owner): see
[docs/setup.md → Upgrading the backend](https://github.com/UncleTalik/sheets-db/blob/main/docs/setup.md#upgrading-the-backend-100--110).

**Compatibility matrix** during a partial rollout:

| Client    | Backend   | `_*` op behaviour                |
|-----------|-----------|----------------------------------|
| `0.2.x`   | `1.0.0`   | Old: `select` succeeded (leaky)  |
| `0.2.x`   | `1.1.0`   | Server returns `unauthorized`    |
| `0.3.0`   | `1.0.0`   | Client short-circuits early      |
| `0.3.0`   | `1.1.0`   | Client short-circuits early      |

Either side can be upgraded first — old clients still work against the
new backend (they just learn about the rejection over the wire instead
of locally).

## Compatibility

The client's **major** version must match the backend's major version. Minor
and patch versions can drift.

## License

MIT
