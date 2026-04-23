/**
 * Create missing tables and populate _meta + _allowlist from a declarative
 * spec. Additive only: creates tables if missing, appends missing columns,
 * appends new allowlist entries. Never drops tables, removes columns, or
 * revokes allowlist entries.
 *
 * Gated to OWNER_EMAIL (Script Property). If not set, provision is disabled
 * entirely — set it in Project Settings → Script properties before calling.
 *
 * Spec shape:
 *   {
 *     tables?: {
 *       [tableName]: [
 *         { column, type, required?, unique?, default? },
 *         ...
 *       ]
 *     },
 *     allowlist?: ["a@example.com", ...]
 *   }
 *
 * Returns:
 *   {
 *     tablesCreated: [...],
 *     tablesSkipped: [...],
 *     columnsAdded: { [tableName]: [...] },
 *     allowlistAdded: [...]
 *   }
 */
function provision(spec, user) {
  const ownerEmail = PropertiesService.getScriptProperties().getProperty("OWNER_EMAIL");
  if (!ownerEmail) {
    throw appError(
      "misconfigured",
      "OWNER_EMAIL script property is not set — required to call provision. Add it in Project Settings → Script properties."
    );
  }
  if (String(ownerEmail).trim().toLowerCase() !== String(user.email).trim().toLowerCase()) {
    throw appError("unauthorized", "provision is restricted to OWNER_EMAIL");
  }

  requireObject(spec, "spec");

  const result = {
    tablesCreated: [],
    tablesSkipped: [],
    columnsAdded: {},
    allowlistAdded: []
  };

  ensureMetaSheet();
  ensureAllowlistSheet();

  if (spec.tables && typeof spec.tables === "object" && !Array.isArray(spec.tables)) {
    for (const tableName in spec.tables) {
      const columns = spec.tables[tableName];
      if (!Array.isArray(columns) || columns.length === 0) {
        throw appError("validation", "tables." + tableName + " must be a non-empty array of column specs");
      }
      columns.forEach(function (c, i) {
        if (!c || typeof c !== "object") {
          throw appError("validation", "tables." + tableName + "[" + i + "] must be an object");
        }
        if (typeof c.column !== "string" || !c.column) {
          throw appError("validation", "tables." + tableName + "[" + i + "].column is required");
        }
        if (typeof c.type !== "string" || !c.type) {
          throw appError("validation", "tables." + tableName + "[" + i + "].type is required");
        }
      });
      const hasId = columns.some(function (c) { return c.column === "id"; });
      if (!hasId) {
        throw appError(
          "validation",
          "tables." + tableName + " must declare an \"id\" column (type string, unique TRUE, default auto). update/delete rely on it."
        );
      }

      const outcome = provisionTable(tableName, columns);
      if (outcome.createdTable) result.tablesCreated.push(tableName);
      else result.tablesSkipped.push(tableName);
      if (outcome.columnsAdded.length > 0) result.columnsAdded[tableName] = outcome.columnsAdded;
    }
  }

  if (Array.isArray(spec.allowlist)) {
    result.allowlistAdded = addAllowlistEntries(spec.allowlist);
  }

  _schemaCache = null;
  return result;
}

function ensureMetaSheet() {
  if (ss().getSheetByName("_meta")) return;
  const sheet = ss().insertSheet("_meta");
  sheet.appendRow(["table", "column", "type", "required", "unique", "default"]);
  sheet.setFrozenRows(1);
}

function ensureAllowlistSheet() {
  if (ss().getSheetByName("_allowlist")) return;
  const sheet = ss().insertSheet("_allowlist");
  sheet.appendRow(["email", "name"]);
  sheet.setFrozenRows(1);
}

function provisionTable(tableName, columns) {
  const outcome = { createdTable: false, columnsAdded: [] };
  let sheet = ss().getSheetByName(tableName);

  if (!sheet) {
    sheet = ss().insertSheet(tableName);
    sheet.getRange(1, 1, 1, columns.length).setValues([columns.map(function (c) { return c.column; })]);
    sheet.setFrozenRows(1);
    outcome.createdTable = true;
  } else {
    const lastCol = sheet.getLastColumn();
    const header = lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String)
      : [];
    const missing = columns
      .map(function (c) { return c.column; })
      .filter(function (col) { return header.indexOf(col) < 0; });
    if (missing.length > 0) {
      const startCol = Math.max(1, lastCol + 1);
      sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
      outcome.columnsAdded = missing;
    }
  }

  syncMetaRows(tableName, columns);
  return outcome;
}

function syncMetaRows(tableName, columns) {
  const meta = ss().getSheetByName("_meta");
  const values = meta.getDataRange().getValues();
  const header = values.shift().map(function (h) { return String(h).trim(); });
  const iTable = header.indexOf("table");
  const iCol = header.indexOf("column");
  if (iTable < 0 || iCol < 0) {
    throw appError("misconfigured", "_meta must have 'table' and 'column' columns");
  }
  const existing = new Set();
  values.forEach(function (r) {
    existing.add(String(r[iTable]).trim() + "::" + String(r[iCol]).trim());
  });

  const rows = [];
  columns.forEach(function (c) {
    if (existing.has(tableName + "::" + c.column)) return;
    rows.push([
      tableName,
      c.column,
      c.type,
      c.required === true ? "TRUE" : "FALSE",
      c.unique === true ? "TRUE" : "FALSE",
      c.default == null ? "" : String(c.default)
    ]);
  });

  if (rows.length > 0) {
    meta.getRange(meta.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
  }
}

function addAllowlistEntries(emails) {
  const sheet = ss().getSheetByName("_allowlist");
  const last = sheet.getLastRow();
  const existing = new Set();
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 1).getValues().flat().forEach(function (e) {
      existing.add(String(e).trim().toLowerCase());
    });
  }

  const added = [];
  const rows = [];
  emails.forEach(function (e) {
    if (typeof e !== "string") return;
    const trimmed = e.trim();
    if (!trimmed) return;
    const normalized = trimmed.toLowerCase();
    if (existing.has(normalized)) return;
    existing.add(normalized);
    rows.push([trimmed, ""]);
    added.push(trimmed);
  });
  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
  }
  return added;
}
