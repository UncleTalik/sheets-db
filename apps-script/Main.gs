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
  return json({ ok: true, data: { service: "sheetsdb", version: "1.4.0" } });
}

function dispatch(op, user, req) {
  switch (op) {
    case "schema":
      return getSchema();

    case "select":
      requireString(req.table, "table");
      rejectSystemTable(req.table);
      return select(req.table, req.where || {}, user);

    case "insert":
      requireString(req.table, "table");
      rejectSystemTable(req.table);
      requireObject(req.row, "row");
      return withLock(() => insert(req.table, req.row, user, {
        shareWith: req.shareWith
      }));

    case "update":
      requireString(req.table, "table");
      rejectSystemTable(req.table);
      requireString(req.id, "id");
      requireObject(req.row, "row");
      return withLock(() => update(req.table, req.id, req.row, user, {
        shareWith: req.shareWith,
        unshareWith: req.unshareWith
      }));

    case "delete":
      requireString(req.table, "table");
      rejectSystemTable(req.table);
      requireString(req.id, "id");
      return withLock(() => remove(req.table, req.id, user));

    case "share":
      requireString(req.table, "table");
      rejectSystemTable(req.table);
      requireString(req.id, "id");
      requireString(req.email, "email");
      requireString(req.perm, "perm");
      return withLock(() => share(req.table, req.id, req.email, req.perm, user));

    case "unshare":
      requireString(req.table, "table");
      rejectSystemTable(req.table);
      requireString(req.id, "id");
      requireString(req.email, "email");
      return withLock(() => unshare(req.table, req.id, req.email, user));

    case "provision":
      requireObject(req.spec, "spec");
      return withLock(() => provision(req.spec, user));

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

// System sheets (names starting with "_") are infrastructure — `_meta`,
// `_allowlist`, and any future `_*` we add. The owner manages them through
// the spreadsheet UI; the RPC surface refuses them outright.
//
// We coerce via String() so a caller can't bypass the check by sending a
// JSON array like ["_meta"] — Sheets would coerce that back to "_meta"
// when used as a sheet name. requireString already rejects non-strings
// before this is reached in dispatch, but the coercion makes the helper
// safe for any future caller.
function isSystemTable(name) {
  return String(name).charAt(0) === "_";
}
function rejectSystemTable(name) {
  if (isSystemTable(name)) {
    throw appError("unauthorized", "table " + name + " is reserved (system table)");
  }
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw appError("busy", "could not acquire lock");
  try { return fn(); } finally { lock.releaseLock(); }
}
