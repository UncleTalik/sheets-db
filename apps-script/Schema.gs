// Per-execution cache. Apps Script re-runs the whole script each request,
// so this is only deduped within a single dispatch.
let _schemaCache = null;

// Magic column name. A table that includes a column literally named this
// becomes row-scoped: the server stamps it on insert and gates every read
// and mutation by a case-insensitive match against the caller's email.
const MAGIC_COL_USER_ID_ = "_userIdentifier";

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
 * `user` + `isInsert` drive the `_userIdentifier` magic-column auto-stamp.
 */
function validateRow(table, row, { existingId = null, user = null, isInsert = false } = {}) {
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

    // Magic column: server stamps the row owner on insert. Comparisons
    // elsewhere are case-insensitive, so no normalization needed on update.
    if (col.column === MAGIC_COL_USER_ID_ && isInsert && user && user.email) {
      v = normalizeEmail_(user.email);
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
