# SheetsDB — Design Spec

A tiny backend-as-a-library for low-scale web apps, built on Google Apps Script + Google Sheets.

## Goals

- Turn a Google Spreadsheet into a typed, validated key-value/row store accessible from a browser frontend.
- Zero hosting cost, zero infrastructure, no secrets in frontend code.
- Per-user identification via Google Sign-In, with an allowlist enforced server-side.
- A clean client library (ORM-style) that's pleasant to use from any frontend.

## Non-goals (for v1)

- High throughput, concurrent-write safety, transactions.
- Complex joins or relational queries.
- Soft deletes, audit logs, role-based permissions (these are natural v2 extensions).

---

## Architecture

```
┌────────────────────┐     ID token       ┌──────────────────────┐
│   Browser (SPA)    │ ─────────────────► │  Apps Script Web App │
│                    │                    │   (runs as OWNER)    │
│  Google Identity   │ ◄───── JSON ─────  │                      │
│  Services          │                    │  - verify ID token   │
│                    │                    │  - check allowlist   │
│  sheetsdb-client   │                    │  - validate schema   │
└────────────────────┘                    │  - CRUD on Sheet     │
                                          └──────────┬───────────┘
                                                     │
                                                     ▼
                                          ┌──────────────────────┐
                                          │  Google Spreadsheet  │
                                          │  (private to owner)  │
                                          │                      │
                                          │  _meta sheet         │
                                          │  users sheet         │
                                          │  <your tables...>    │
                                          └──────────────────────┘
```

Three components:

1. **Apps Script Web App** (backend) — a single `doPost` endpoint that accepts a JSON RPC-style request, verifies the caller, and performs the operation.
2. **Spreadsheet** — one spreadsheet, each sheet is a table, with a special `_meta` sheet holding schemas and an `_allowlist` sheet holding permitted users.
3. **`sheetsdb-client`** — a browser JS/TS library that wraps Google Sign-In and the RPC calls in an ORM-style API.

---

## Authentication flow

1. The frontend loads Google Identity Services (GIS) and requests an **ID token** for a known Google OAuth client ID.
2. GIS returns a signed JWT (`credential`) identifying the user by email.
3. The frontend sends every RPC request with `Authorization: Bearer <id_token>` in the JSON body (Apps Script web apps can't read arbitrary headers reliably, so it goes in the body).
4. The Apps Script backend:
   - Verifies the JWT signature by calling Google's tokeninfo endpoint: `https://oauth2.googleapis.com/tokeninfo?id_token=...`
   - Confirms `aud` matches the expected OAuth client ID.
   - Confirms `email_verified === true`.
   - Checks the email against the `_allowlist` sheet.
   - If any check fails, returns `{ ok: false, error: "unauthorized" }`.

The Apps Script **runs as the deploying user (you)**, which means:
- The Sheet stays private — only you have direct access.
- The script uses your credentials to read/write, so the frontend never touches the Sheet directly.
- "Who can access the web app" is set to **Anyone** (because the browser can't authenticate as a Google user to an Apps Script URL); the allowlist check is what actually protects you.

---

## Spreadsheet layout

### `_meta` sheet (schema registry)

| table     | column    | type      | required | unique | default       |
|-----------|-----------|-----------|----------|--------|---------------|
| expenses  | id        | string    | TRUE     | TRUE   | auto          |
| expenses  | createdAt | datetime  | TRUE     | FALSE  | now           |
| expenses  | amount    | number    | TRUE     | FALSE  |               |
| expenses  | category  | string    | TRUE     | FALSE  |               |
| expenses  | note      | string    | FALSE    | FALSE  |               |
| chores    | id        | string    | TRUE     | TRUE   | auto          |
| chores    | createdAt | datetime  | TRUE     | FALSE  | now           |
| chores    | title     | string    | TRUE     | FALSE  |               |
| chores    | assignee  | string    | TRUE     | FALSE  |               |
| chores    | done      | boolean   | TRUE     | FALSE  | false         |

- Supported types: `string`, `number`, `boolean`, `datetime`, `enum:a|b|c`.
- `default: auto` generates a short ID (e.g. `exp_k3j8f2a`).
- `default: now` fills with the current ISO timestamp.
- The schema is read at the start of every request (cached in-script for the lifetime of the execution).

### `_allowlist` sheet

| email                  | name     |
|------------------------|----------|
| you@example.com        | Owner    |
| spouse@example.com     | Spouse   |
| kid1@example.com       | Kid 1    |

### Data sheets (e.g. `expenses`)

Row 1 is a header row with column names that must match the schema in `_meta`. The backend reads the header row to map column names to column indices.

---

## RPC protocol

Single endpoint: `POST <web-app-url>`

Request body:
```json
{
  "idToken": "eyJhbGc...",
  "op": "select" | "insert" | "update" | "delete" | "schema",
  "table": "expenses",
  "where": { "category": "groceries" },
  "row": { "amount": 42.5, "category": "groceries", "note": "milk" },
  "id": "exp_k3j8f2a"
}
```

Response body:
```json
{ "ok": true, "data": [...] }
// or
{ "ok": false, "error": "unauthorized" | "validation" | "not_found" | "..." , "details": {...} }
```

Operations:

| op       | required params         | returns                          |
|----------|-------------------------|----------------------------------|
| `schema` | —                       | `{ tables: { expenses: [...] } }`|
| `select` | `table`, `where?`       | array of row objects             |
| `insert` | `table`, `row`          | inserted row (with generated id) |
| `update` | `table`, `id`, `row`    | updated row                      |
| `delete` | `table`, `id`           | `{ id }`                         |

`where` is an object of equality filters ANDed together. No `$gt`/`$lt`/`$or` in v1 — keep it simple; clients can filter further in memory.

---

## Backend: Apps Script — full reference implementation

The code below is meant to be **working reference code**, not pseudocode. Claude Code can use these files as-is for v1 and extend from there. One Apps Script project, five `.gs` files plus the manifest.

### `appsscript.json` (manifest)
```json
{
  "timeZone": "America/New_York",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE"
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.external_request"
  ]
}
```

### `Main.gs` — entry point, dispatch, response helpers
```js
/**
 * Single POST endpoint. All requests come in as JSON:
 *   { idToken, op, table?, where?, row?, id? }
 * Responses are always JSON with shape:
 *   { ok: true, data: ... }  |  { ok: false, error: string, details?: string }
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: "bad_request", details: "no body" });
    }
    const req = JSON.parse(e.postData.contents);
    const user = verifyAuth(req.idToken);            // throws AppError on failure
    const result = dispatch(req.op, user, req);
    return json({ ok: true, data: result });
  } catch (err) {
    const code = err && err.code ? err.code : "internal";
    const details = err && err.message ? err.message : String(err);
    console.error(code, details, err && err.stack);
    return json({ ok: false, error: code, details });
  }
}

function doGet() {
  // Health check — useful when you paste the /exec URL into a browser.
  return json({ ok: true, data: { service: "sheetsdb", version: "1.0.0" } });
}

function dispatch(op, user, req) {
  switch (op) {
    case "schema":
      return getSchema();

    case "select":
      requireString(req.table, "table");
      return select(req.table, req.where || {});

    case "insert":
      requireString(req.table, "table");
      requireObject(req.row, "row");
      return withLock(() => insert(req.table, req.row, user));

    case "update":
      requireString(req.table, "table");
      requireString(req.id, "id");
      requireObject(req.row, "row");
      return withLock(() => update(req.table, req.id, req.row, user));

    case "delete":
      requireString(req.table, "table");
      requireString(req.id, "id");
      return withLock(() => remove(req.table, req.id, user));

    default:
      throw appError("bad_op", "unknown op: " + op);
  }
}

// --- helpers --------------------------------------------------------------

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ss() {
  // Bound script: no ID needed. If you unbind it later, switch to openById().
  return SpreadsheetApp.getActiveSpreadsheet();
}

function appError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function requireString(v, name) {
  if (typeof v !== "string" || !v) throw appError("bad_request", name + " must be a non-empty string");
}
function requireObject(v, name) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw appError("bad_request", name + " must be an object");
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw appError("busy", "could not acquire lock");
  try { return fn(); } finally { lock.releaseLock(); }
}
```

### `Auth.gs` — ID token verification + allowlist
```js
/**
 * Verifies a Google ID token via the tokeninfo endpoint, checks audience,
 * email verification status, and allowlist membership.
 * Returns { email, name } on success; throws AppError on failure.
 */
function verifyAuth(idToken) {
  if (!idToken || typeof idToken !== "string") {
    throw appError("unauthorized", "missing idToken");
  }

  const expectedAud = PropertiesService.getScriptProperties().getProperty("OAUTH_CLIENT_ID");
  if (!expectedAud) {
    throw appError("misconfigured", "OAUTH_CLIENT_ID script property not set");
  }

  const url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw appError("unauthorized", "tokeninfo rejected token (" + resp.getResponseCode() + ")");
  }

  const claims = JSON.parse(resp.getContentText());

  // aud must match our OAuth client
  if (claims.aud !== expectedAud) {
    throw appError("unauthorized", "audience mismatch");
  }
  // iss must be Google
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    throw appError("unauthorized", "bad issuer");
  }
  // not expired (tokeninfo returns "exp" in seconds as a string)
  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.exp && Number(claims.exp) < nowSec) {
    throw appError("unauthorized", "token expired");
  }
  // email must be present and verified
  if (!claims.email) throw appError("unauthorized", "no email in token");
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (!verified) throw appError("unauthorized", "email not verified");

  if (!isAllowed(claims.email)) {
    throw appError("unauthorized", "not in allowlist: " + claims.email);
  }

  return { email: claims.email, name: claims.name || "" };
}

function isAllowed(email) {
  const sheet = ss().getSheetByName("_allowlist");
  if (!sheet) throw appError("misconfigured", "_allowlist sheet missing");
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const emails = sheet.getRange(2, 1, last - 1, 1).getValues()
    .flat()
    .map(s => String(s).trim().toLowerCase())
    .filter(Boolean);
  return emails.indexOf(String(email).trim().toLowerCase()) >= 0;
}
```

### `Schema.gs` — read `_meta`, validate rows, apply defaults
```js
// Per-execution cache. Apps Script re-runs the whole script each request,
// so this is only deduped within a single dispatch.
let _schemaCache = null;

/**
 * Returns { tableName: [ { column, type, required, unique, default }, ... ] }
 */
function getSchema() {
  if (_schemaCache) return _schemaCache;
  const sheet = ss().getSheetByName("_meta");
  if (!sheet) throw appError("misconfigured", "_meta sheet missing");

  const rows = sheet.getDataRange().getValues();
  const header = rows.shift().map(h => String(h).trim());
  const idx = name => {
    const i = header.indexOf(name);
    if (i < 0) throw appError("misconfigured", "_meta missing column: " + name);
    return i;
  };
  const iTable = idx("table"), iCol = idx("column"), iType = idx("type"),
        iReq = idx("required"), iUniq = idx("unique"), iDef = idx("default");

  const out = {};
  rows.forEach(r => {
    const table = String(r[iTable]).trim();
    if (!table) return;
    if (!out[table]) out[table] = [];
    out[table].push({
      column: String(r[iCol]).trim(),
      type: String(r[iType]).trim() || "string",
      required: coerceBool(r[iReq]),
      unique: coerceBool(r[iUniq]),
      default: r[iDef] === "" ? null : String(r[iDef]).trim()
    });
  });
  _schemaCache = out;
  return out;
}

function tableSchema(table) {
  const s = getSchema()[table];
  if (!s) throw appError("not_found", "unknown table: " + table);
  return s;
}

/**
 * Clean, validate, and apply defaults. Returns a new row object safe to write.
 * `existingId` is passed on updates so the uniqueness check can skip the current row.
 */
function validateRow(table, row, { existingId = null } = {}) {
  const schema = tableSchema(table);
  const clean = {};

  for (const col of schema) {
    let v = row[col.column];

    // Apply defaults if missing
    if (v === undefined || v === null || v === "") {
      if (col.default === "auto" && col.column === "id") {
        v = generateId(table);
      } else if (col.default === "now") {
        v = new Date().toISOString();
      } else if (col.default !== null) {
        v = col.default;
      }
    }

    // Required check
    if ((v === undefined || v === null || v === "") && col.required) {
      throw appError("validation", "missing required field: " + col.column);
    }

    // Type coercion / validation
    if (v !== undefined && v !== null && v !== "") {
      v = coerceType(v, col.type, col.column);
    }

    // Uniqueness
    if (col.unique && v !== undefined && v !== null && v !== "") {
      if (!isUnique(table, col.column, v, existingId)) {
        throw appError("validation", "duplicate value for unique field: " + col.column);
      }
    }

    clean[col.column] = v === undefined ? "" : v;
  }
  return clean;
}

function coerceType(v, type, colName) {
  if (type === "string") return String(v);
  if (type === "number") {
    const n = Number(v);
    if (Number.isNaN(n)) throw appError("validation", colName + " must be a number");
    return n;
  }
  if (type === "boolean") {
    if (typeof v === "boolean") return v;
    const s = String(v).toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0" || s === "") return false;
    throw appError("validation", colName + " must be a boolean");
  }
  if (type === "datetime") {
    const d = new Date(v);
    if (isNaN(d.getTime())) throw appError("validation", colName + " must be a date");
    return d.toISOString();
  }
  if (type.indexOf("enum:") === 0) {
    const allowed = type.slice(5).split("|").map(s => s.trim());
    const s = String(v);
    if (allowed.indexOf(s) < 0) {
      throw appError("validation", colName + " must be one of: " + allowed.join(", "));
    }
    return s;
  }
  // Unknown type: pass through as string
  return String(v);
}

function coerceBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toUpperCase();
  return s === "TRUE" || s === "1" || s === "YES";
}

function generateId(table) {
  const prefix = table.slice(0, 3).toLowerCase();
  const rand = Utilities.getUuid().replace(/-/g, "").slice(0, 10);
  return prefix + "_" + rand;
}

function isUnique(table, column, value, existingId) {
  const sheet = ss().getSheetByName(table);
  if (!sheet || sheet.getLastRow() < 2) return true;
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIdx = header.indexOf(column);
  const idIdx = header.indexOf("id");
  if (colIdx < 0) return true;
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (const r of data) {
    if (String(r[colIdx]) === String(value)) {
      if (existingId !== null && idIdx >= 0 && String(r[idIdx]) === String(existingId)) {
        continue; // it's the row we're updating; don't count it as a collision
      }
      return false;
    }
  }
  return true;
}
```

### `Table.gs` — CRUD against the data sheets
```js
function getSheet(table) {
  const sheet = ss().getSheetByName(table);
  if (!sheet) throw appError("not_found", "no such sheet: " + table);
  return sheet;
}

function getHeader(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(s => String(s));
}

function rowToObj(header, row) {
  const obj = {};
  for (let i = 0; i < header.length; i++) obj[header[i]] = row[i];
  return obj;
}

function matchesWhere(obj, where) {
  for (const k in where) {
    // Loose equality so "42" from the sheet matches 42 from the filter
    if (String(obj[k]) !== String(where[k])) return false;
  }
  return true;
}

function findRowIndexById(sheet, id) {
  const header = getHeader(sheet);
  const idCol = header.indexOf("id");
  if (idCol < 0) throw appError("misconfigured", "table has no id column");
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const ids = sheet.getRange(2, idCol + 1, last - 1, 1).getValues().flat().map(String);
  const pos = ids.indexOf(String(id));
  return pos < 0 ? -1 : pos + 2; // +2: header row + 1-indexed
}

function select(table, where) {
  const sheet = getSheet(table);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues();
  const header = values.shift().map(String);
  return values
    .map(r => rowToObj(header, r))
    .filter(obj => matchesWhere(obj, where));
}

function insert(table, row, user) {
  const sheet = getSheet(table);
  const header = getHeader(sheet);
  const clean = validateRow(table, row);
  sheet.appendRow(header.map(col => toCell(clean[col])));
  return clean;
}

function update(table, id, patch, user) {
  const sheet = getSheet(table);
  const rowIdx = findRowIndexById(sheet, id);
  if (rowIdx < 0) throw appError("not_found", "no row with id=" + id);

  const header = getHeader(sheet);
  const current = rowToObj(header, sheet.getRange(rowIdx, 1, 1, header.length).getValues()[0]);

  // Merge, then validate the full row. Force id; refresh updatedAt if the schema has it.
  const merged = Object.assign({}, current, patch, { id });
  if (header.indexOf("updatedAt") >= 0) merged.updatedAt = new Date().toISOString();

  const clean = validateRow(table, merged, { existingId: id });
  sheet.getRange(rowIdx, 1, 1, header.length).setValues([header.map(col => toCell(clean[col]))]);
  return clean;
}

function remove(table, id) {
  const sheet = getSheet(table);
  const rowIdx = findRowIndexById(sheet, id);
  if (rowIdx < 0) throw appError("not_found", "no row with id=" + id);
  sheet.deleteRow(rowIdx);
  return { id };
}

function toCell(v) {
  // Sheets prefers primitives; undefined/null become empty strings.
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v;
  return v;
}
```

### `Test.gs` — a manual smoke test you can run from the Apps Script editor
```js
/**
 * Run this from the editor (Run > runSmokeTest) after filling in _meta,
 * _allowlist, and creating a test sheet. It bypasses auth by calling the
 * CRUD functions directly. Useful for sanity-checking schema + validation.
 */
function runSmokeTest() {
  _schemaCache = null; // reset
  const fakeUser = { email: "smoke@test", name: "Smoke" };

  const created = insert("expenses", { amount: 12.5, category: "groceries", note: "test" }, fakeUser);
  console.log("inserted:", created);

  const all = select("expenses", { category: "groceries" });
  console.log("selected:", all.length, "rows");

  const updated = update("expenses", created.id, { amount: 13.5 }, fakeUser);
  console.log("updated:", updated);

  const removed = remove("expenses", created.id);
  console.log("removed:", removed);
}
```

### Implementation notes
- **Locking**: only mutations go through `withLock()`. Reads don't need the lock and would hurt throughput if they did.
- **Schema cache**: `_schemaCache` dedupes `getSchema()` calls within a single dispatch. Cross-request caching would need `CacheService`; not worth it at family scale.
- **ID generation**: prefix + 10 hex chars gives ~40 bits of entropy, which is plenty for collision avoidance in a family app. The uniqueness check in `validateRow` catches any collision anyway.
- **Column order in the sheet must match schema**: the header row is the source of truth for column positions; the schema is the source of truth for types and defaults. Both should list the same columns. If you add a column, add it to both.
- **`executeAs: USER_DEPLOYING`** in the manifest is equivalent to selecting "Execute as: Me" in the deploy dialog. Pin it here so a fresh deployment doesn't accidentally run as the caller.

---

## Client library: `sheetsdb-client`

Shape (TypeScript):

```ts
type Row = Record<string, any>;
type Where = Record<string, string | number | boolean>;

interface TableQuery<T = Row> {
  where(filter: Where): TableQuery<T>;
  select(): Promise<T[]>;
  selectOne(): Promise<T | null>;
  insert(row: Partial<T>): Promise<T>;
  update(id: string, patch: Partial<T>): Promise<T>;
  delete(id: string): Promise<{ id: string }>;
}

interface SheetsDB {
  signIn(): Promise<{ email: string; name: string }>;
  signOut(): void;
  currentUser(): { email: string; name: string } | null;
  table<T = Row>(name: string): TableQuery<T>;
  schema(): Promise<Record<string, ColumnDef[]>>;
}

function createClient(config: {
  webAppUrl: string;
  googleClientId: string;
}): SheetsDB;
```

Usage:

```ts
import { createClient } from "sheetsdb-client";

const db = createClient({
  webAppUrl: "https://script.google.com/macros/s/AKfy.../exec",
  googleClientId: "1234-abc.apps.googleusercontent.com",
});

await db.signIn();  // shows Google popup, stores id token in memory

const expenses = await db
  .table("expenses")
  .where({ category: "groceries" })
  .select();

const created = await db.table("expenses").insert({
  amount: 42.5,
  category: "groceries",
  note: "milk",
});

await db.table("expenses").update(created.id, { amount: 43 });
await db.table("expenses").delete(created.id);
```

### Internals
- `signIn()` wraps `google.accounts.id.initialize` + `prompt()` and resolves when the user picks an account. The returned JWT is stored in a module-level variable (NOT localStorage — tokens are short-lived and should be re-requested on reload).
- Every call builds the RPC body with the current `idToken` and does `fetch(webAppUrl, { method: "POST", body: JSON.stringify(...) })`. Use `redirect: "follow"` because Apps Script responds with a 302 to a `googleusercontent.com` URL.
- The query builder is immutable — each `.where()` returns a new object — so `db.table("x")` can be reused.

---

## Packaging the client library (GitHub Packages, private)

The client ships as a private npm package on GitHub Packages. This keeps the package visible only to people you've given repo access to, costs nothing, and integrates cleanly with GitHub Actions for publishing. Here's the full setup.

### `client/package.json`
```json
{
  "name": "@YOUR_GITHUB_USERNAME/sheetsdb-client",
  "version": "0.1.0",
  "description": "Typed client for the SheetsDB Apps Script backend",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist", "README.md"],
  "sideEffects": false,
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/YOUR_GITHUB_USERNAME/sheetsdb.git"
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts --clean --sourcemap",
    "dev": "tsup src/index.ts --format esm,cjs --dts --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "prepublishOnly": "npm run build && npm run test && npm run typecheck"
  },
  "devDependencies": {
    "@types/google.accounts": "^0.0.14",
    "tsup": "^8.0.0",
    "typescript": "^5.3.0",
    "vitest": "^1.0.0"
  },
  "peerDependencies": {},
  "keywords": ["google-sheets", "apps-script", "backend", "database"],
  "license": "MIT"
}
```

**Critical fields for GitHub Packages:**
- **The `name` must be scoped to your GitHub username or org** — GitHub Packages only accepts scoped names (`@user/pkg` or `@org/pkg`). Unscoped names won't publish.
- **The `repository.url` must point at the GitHub repo that owns the package.** GitHub uses this to link the package to the repo and to determine who can publish (anyone with write access to that repo).
- **`publishConfig.registry`** makes `npm publish` push to GitHub's registry by default. No need for `--registry` flags.

**Why the other choices:**
- **Dual ESM + CJS output** via `tsup` so the package works in both modern bundlers (Vite, Next.js, esbuild) and older CommonJS consumers.
- **No runtime dependencies.** The client uses `fetch` (built-in) and Google Identity Services (loaded from `https://accounts.google.com/gsi/client` at runtime). Zero deps means zero supply-chain surface and no version-conflict headaches for consumers.
- **`sideEffects: false`** enables tree-shaking — consumers only pay for what they import.
- **`prepublishOnly`** guarantees the package is built, tested, and typechecked before every publish.

### `client/tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2020", "DOM"],
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["google.accounts", "vitest/globals"]
  },
  "include": ["src"]
}
```

### Publishing to GitHub Packages (private)

The package will live under your GitHub account/org and only people you grant access to can install it. The repo itself can be private too — GitHub Packages inherits visibility from the repo.

**One-time setup on your machine:**

1. Create a **Personal Access Token (classic)** at https://github.com/settings/tokens with scopes `write:packages`, `read:packages`, and `repo` (the last is only needed if the repo is private). Call it something like `sheetsdb-publish`.

2. Create `~/.npmrc` (or add to it):
   ```
   //npm.pkg.github.com/:_authToken=ghp_YOUR_TOKEN_HERE
   @YOUR_GITHUB_USERNAME:registry=https://npm.pkg.github.com
   ```
   The second line tells npm that any package starting with your scope should come from GitHub Packages instead of the public npm registry.

**Publishing a version:**
```bash
cd client
npm version patch    # or minor / major — bumps version + creates a git tag
npm publish
git push --follow-tags
```

That's it. The package appears under your repo's **Packages** tab on GitHub, and the version is locked in (GitHub Packages doesn't allow republishing the same version, same as npm).

### Consuming the package from a webapp repo

The realistic setup has **two repos**:

- **Repo A — `sheetsdb`**: the Apps Script backend + the client package source. Publishes `@YOUR_GITHUB_USERNAME/sheetsdb-client` to GitHub Packages on tag push.
- **Repo B — `family-expenses`** (or whatever your actual web app is called): a static frontend that depends on `@YOUR_GITHUB_USERNAME/sheetsdb-client` and deploys to GitHub Pages.

The package is only needed **at build time**. The browser never calls `npm install` — it runs the bundled JavaScript that the build produced. So the token only needs to live in two places: your local machine (for development) and Repo B's GitHub Actions secrets (for the Pages deploy). It is never sent to the browser.

**Why the built-in `GITHUB_TOKEN` isn't enough.** GitHub Actions provides a `GITHUB_TOKEN` automatically, but by default it can only read packages from the same repo that's running the workflow. Repo B's workflow needs to read a package published from Repo A — a different repo — so the built-in token won't work. You need a **Personal Access Token** stored as a repo secret in Repo B.

#### One-time setup

**1. Create a PAT for installs.** At https://github.com/settings/tokens, create a classic PAT with the scope `read:packages` only. Call it something like `sheetsdb-install`. Copy the token — you'll only see it once.

**2. Add the PAT as a secret in Repo B.** In Repo B on GitHub → Settings → Secrets and variables → Actions → New repository secret. Name it `PACKAGES_TOKEN`, paste the PAT.

**3. Add the same PAT to your local shell** (for development and local builds):
```bash
# in ~/.zshrc or ~/.bashrc
export GITHUB_PACKAGES_TOKEN=ghp_your_token_here
```

#### In Repo B

**`.npmrc`** (commit this — there are no secrets in it):
```
@YOUR_GITHUB_USERNAME:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```
The `${GITHUB_PACKAGES_TOKEN}` is a literal — npm substitutes it from the environment at install time. Using a distinct name (`GITHUB_PACKAGES_TOKEN` instead of `GITHUB_TOKEN`) avoids collisions with GitHub Actions' built-in token, which has a different value and different scopes.

**Install the package:**
```bash
npm install @YOUR_GITHUB_USERNAME/sheetsdb-client
```

**Import and use:**
```ts
import { createClient } from "@YOUR_GITHUB_USERNAME/sheetsdb-client";
```

**`.github/workflows/deploy.yml`** — builds and deploys Repo B to GitHub Pages:
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
          scope: '@YOUR_GITHUB_USERNAME'

      - name: Install dependencies (reads @YOUR_GITHUB_USERNAME/* from GitHub Packages)
        run: npm ci
        env:
          # Maps the PACKAGES_TOKEN secret to the env var that .npmrc references.
          GITHUB_PACKAGES_TOKEN: ${{ secrets.PACKAGES_TOKEN }}
          # actions/setup-node also sets NODE_AUTH_TOKEN; include it for belt-and-suspenders.
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

The `VITE_SHEETSDB_URL` and `VITE_GOOGLE_CLIENT_ID` are the web app URL and OAuth client ID from the Apps Script deployment — also stored as repo secrets. They're inlined into the bundle at build time; that's fine because neither is actually secret (the web app URL is public anyway, and OAuth client IDs are designed to be public).

#### What lives where — summary

| Where | What | Why |
|---|---|---|
| Repo A (`sheetsdb`) | Apps Script, client source, publishes package | Source of truth for the backend and the library |
| Repo B (`family-expenses`) | Webapp, depends on the package | The thing your family actually opens |
| Repo B secrets | `PACKAGES_TOKEN` (PAT with `read:packages`) | Needed by `npm install` in CI |
| Repo B secrets | `SHEETSDB_URL`, `GOOGLE_CLIENT_ID` | Build-time config, inlined into bundle |
| Your shell | `GITHUB_PACKAGES_TOKEN` env var | Same PAT, for local `npm install` |
| `_allowlist` sheet | Family members' emails | Runtime auth — who can use the app |

Note the last row: **the package's access controls and your app's access controls are completely independent.** The PAT controls "who can install the library." The `_allowlist` sheet controls "who can use the deployed app." Only you need the PAT. Your family only needs to be on the allowlist.

### The one gotcha worth flagging

GitHub Packages does **not** support unauthenticated installs. Even if your repo is public, consumers still need a token to `npm install` the package. This surprises people. If you ever want fully open installs, publish to the public npm registry instead — GitHub Packages is always token-gated.

### README.md for the package

The `client/README.md` should be short and task-oriented. Minimum sections:

1. **One-line description** and a 10-line code example showing sign-in + one CRUD operation.
2. **Install** — show the scoped install (`npm install @YOUR_GITHUB_USERNAME/sheetsdb-client`) **and** the `.npmrc` + `GITHUB_TOKEN` requirement. This is the #1 place people will get stuck.
3. **Prerequisites** — link to the main setup doc for the Apps Script + Sheet setup. Make it obvious the client is useless without the backend deployed.
4. **API reference** — the `createClient`, `signIn`, `table().where().select()/insert()/update()/delete()` methods with TypeScript signatures and one example each.
5. **Typed tables** — show how to pass a type parameter: `db.table<Expense>("expenses")` and how to define the `Expense` interface.
6. **Error handling** — list the error codes the backend returns (`unauthorized`, `validation`, `not_found`, `bad_request`, `busy`, `internal`) and show a `try/catch` example.
7. **Token lifetime** — explain that the ID token is in-memory only and the user must re-sign-in on page reload.

### Using the package in a consumer app

A typed React example (the realistic case, since private-package consumers use a bundler):

```tsx
import { createClient } from "@YOUR_GITHUB_USERNAME/sheetsdb-client";
import { useEffect, useState } from "react";

interface Expense {
  id: string;
  createdAt: string;
  amount: number;
  category: string;
  note?: string;
}

const db = createClient({
  webAppUrl: import.meta.env.VITE_SHEETSDB_URL,
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
});

export function ExpenseList() {
  const [rows, setRows] = useState<Expense[]>([]);
  useEffect(() => {
    db.signIn()
      .then(() => db.table<Expense>("expenses").select())
      .then(setRows);
  }, []);
  return <ul>{rows.map(r => <li key={r.id}>{r.category}: ${r.amount}</li>)}</ul>;
}
```

The consumer's `index.html` still needs the Google Identity Services script tag, which isn't bundled:
```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
```

Note: there's no equivalent of the `esm.sh` zero-install path for private GitHub Packages — every consumer must authenticate with `npm install`. If you want an unauthenticated drop-in option for prototypes, you'd need to publish to public npm instead.

### Versioning and releases

Use semver and tag releases:
- **Patch** (`0.1.0 → 0.1.1`): bug fixes, no API changes.
- **Minor** (`0.1.0 → 0.2.0`): new features, backwards-compatible.
- **Major** (`0.x.y → 1.0.0`): breaking changes.

The backend and client version independently but follow this compatibility rule: **the client's major version must match the backend's major version**. If you ever change the RPC wire format, bump both. Document this in both READMEs.

### What Claude Code should produce for packaging

- `client/package.json` and `client/tsconfig.json` as above, with the scoped name and `publishConfig.registry` set.
- `client/tsup.config.ts` if tsup needs more than the CLI flags (usually not).
- `client/README.md` covering the seven sections listed, with prominent `.npmrc` + `GITHUB_TOKEN` setup instructions.
- An `example/.npmrc` showing consumers how to authenticate (the `${GITHUB_TOKEN}` pattern, not a hardcoded token).
- A `.github/workflows/publish.yml` that publishes to GitHub Packages on tag push:
  ```yaml
  name: Publish client to GitHub Packages
  on:
    push:
      tags: ['v*']
  jobs:
    publish:
      runs-on: ubuntu-latest
      permissions:
        contents: read
        packages: write     # required to publish to GitHub Packages
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 20
            registry-url: 'https://npm.pkg.github.com'
            scope: '@YOUR_GITHUB_USERNAME'
        - run: npm ci
          working-directory: client
        - run: npm run build && npm test
          working-directory: client
        - run: npm publish
          working-directory: client
          env:
            NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  ```
  The built-in `GITHUB_TOKEN` already has `packages: write` when you grant it via the `permissions` block — no PAT needed in CI.

---

## Deployment & setup (the runbook for Claude Code to produce)

1. **Create the Spreadsheet** manually in Google Drive. Add sheets: `_meta`, `_allowlist`, and one data sheet per table with headers matching the schema.
2. **Create the Apps Script project** bound to that Spreadsheet (Extensions → Apps Script). Paste in the four `.gs` files.
3. **Set Script Properties**: Project Settings → Script properties → add `OAUTH_CLIENT_ID` with the value of the Google OAuth client ID (created in step 4).
4. **Create an OAuth client ID** in Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID → Web application. Add the frontend's origin (e.g. `https://username.github.io`) to Authorized JavaScript origins.
5. **Deploy the Apps Script as a Web App**: Deploy → New deployment → Type: Web app → Execute as: *Me* → Who has access: *Anyone*. Copy the `/exec` URL.
6. **Configure the frontend** with the web app URL and OAuth client ID, then ship.

---

## Repo layout Claude Code should produce

```
sheetsdb/
├── README.md
├── apps-script/
│   ├── appsscript.json           # manifest (executeAs: USER_DEPLOYING, access: ANYONE)
│   ├── Main.gs                   # doPost/doGet, dispatch, withLock, response helpers
│   ├── Auth.gs                   # verifyAuth, isAllowed
│   ├── Schema.gs                 # getSchema, validateRow, coerceType, generateId
│   ├── Table.gs                  # select, insert, update, remove + sheet helpers
│   └── Test.gs                   # runSmokeTest (manual, run from editor)
├── client/                       # the npm package: sheetsdb-client
│   ├── package.json              # dual ESM+CJS, zero runtime deps, tsup build
│   ├── tsconfig.json
│   ├── tsup.config.ts            # optional; can use CLI flags instead
│   ├── README.md                 # per-package readme (install, API, errors)
│   ├── src/
│   │   ├── index.ts              # createClient, SheetsDB interface (public API)
│   │   ├── auth.ts               # GIS wrapper
│   │   ├── rpc.ts                # fetch + error handling
│   │   ├── query.ts              # TableQuery builder
│   │   └── types.ts              # shared types: Row, Where, ColumnDef, AppError
│   ├── tests/
│   │   └── query.test.ts         # unit tests for the query builder (mocked rpc)
│   └── dist/                     # build output (gitignored; published to npm)
├── example/                      # in-repo demo consumer (dev-time only)
│   ├── .npmrc                    # scoped registry + ${GITHUB_PACKAGES_TOKEN}
│   ├── index.html                # minimal demo app (expense tracker)
│   └── app.ts
├── .github/
│   └── workflows/
│       └── publish.yml           # publish client to npm on tag push
└── docs/
    ├── setup.md                  # the runbook above, step by step with screenshots
    ├── schema.md                 # how to define tables in _meta
    └── consumer-setup.md         # how to set up a SEPARATE webapp repo that consumes the package
```

**Note**: the `example/` folder is a dev-time consumer living inside Repo A, useful for testing the client against the backend during development (typically via npm workspaces so you don't need to publish every change). Your **real** family webapp lives in a **separate repo (Repo B)** with its own `.npmrc`, `PACKAGES_TOKEN` secret, and GitHub Pages deploy workflow — see the "Consuming the package from a webapp repo" section for the full setup. Claude Code should produce `docs/consumer-setup.md` as a copy-pasteable runbook for setting up Repo B.

---

## Open questions for v2

- Should reads be cached client-side with a TTL? (Sheets API is slow-ish — 500ms-1s per call.)
- Add a `batch` op that accepts an array of operations and runs them under a single lock.
- Add `where` operators beyond equality (`$gt`, `$in`, `$contains`).
- Optional server-side computed columns (e.g., `total = quantity * price`).
- Migrate the allowlist check to also accept Google Groups (so you add family members once to a group instead of editing the sheet).

---

## What to tell Claude Code

> Implement the design in `sheets-backend-design.md`.
>
> **Backend**: the Apps Script has working reference code for all five `.gs` files plus the manifest — copy those in verbatim as v1.
>
> **Client**: build the TypeScript client in `client/` as a private npm package on GitHub Packages, per the "Packaging the client library" section — scoped name (`@YOUR_GITHUB_USERNAME/sheetsdb-client`), `publishConfig.registry` pointing at `https://npm.pkg.github.com`, dual ESM+CJS output with tsup, zero runtime dependencies, typed `createClient` API, and the query builder split across `rpc.ts`, `auth.ts`, `query.ts`, `types.ts`, `index.ts`. Write Vitest tests for the query builder that mock the RPC layer. Produce a `client/README.md` covering install (with prominent `.npmrc` + `GITHUB_PACKAGES_TOKEN` setup — use this distinct name to avoid collision with GitHub Actions' built-in `GITHUB_TOKEN`), prerequisites, API reference, typed tables, error codes, and token lifetime. Set up the GitHub Actions workflow at `.github/workflows/publish.yml` that publishes to GitHub Packages on tag push, using the built-in `GITHUB_TOKEN` with `packages: write` permission. Replace every `YOUR_GITHUB_USERNAME` placeholder once with the actual username.
>
> **Example (in-repo)**: build the expense tracker in `example/` as a dev-time consumer of the local `client/` via npm workspaces. This is for testing during development, not the production family app.
>
> **Docs**: write `docs/setup.md` as a step-by-step runbook a non-developer could follow — create the spreadsheet with `_meta` and `_allowlist` sheets, paste in the Apps Script files, create the OAuth client ID, set the `OAUTH_CLIENT_ID` script property, and deploy as a Web App with "Execute as: Me" and "Who has access: Anyone". **Also write `docs/consumer-setup.md`** — a runbook for setting up a SEPARATE webapp repo (Repo B) that consumes the private package and deploys to GitHub Pages. This covers: creating a PAT with `read:packages`, storing it as `PACKAGES_TOKEN` secret in Repo B, committing `.npmrc` with `${GITHUB_PACKAGES_TOKEN}` substitution, and the `deploy.yml` workflow that maps `secrets.PACKAGES_TOKEN` to both `GITHUB_PACKAGES_TOKEN` and `NODE_AUTH_TOKEN` during `npm ci`. Make it explicit that this token is ONLY for build-time `npm install` — it never reaches the browser.
>
> **Invariants**: do not store the ID token in `localStorage`. Wrap all mutations in `withLock()`; do not lock reads. Client has zero runtime dependencies. Client's major version must match backend's major version.