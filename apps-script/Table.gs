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

// Recognized operator names. Keep in sync with WhereOperators in client/src/types.ts.
const OPERATORS_ = {
  eq: true, ne: true, gt: true, gte: true, lt: true, lte: true,
  like: true, in: true, nin: true
};

// Defense against ReDoS on the `like` regex compiled from user input.
const LIKE_MAX_LEN_ = 256;
const LIKE_MAX_WILDCARDS_ = 8;

function isOperators_(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function cmp_(a, b, type) {
  if (type === "number") {
    const an = Number(a), bn = Number(b);
    if (!isNaN(an) && !isNaN(bn)) {
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
    }
    // mixed/non-numeric: fall through to lex compare
  } else if (type === "boolean") {
    const ab = coerceBool(a), bb = coerceBool(b);
    if (ab === bb) return 0;
    return ab ? 1 : -1; // false < true
  }
  // datetime values are stored as ISO strings (Schema.gs:107) → lex == chrono.
  // string / enum:* / anything else → lex.
  const sa = String(a), sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function likePredicate_(pattern) {
  if (typeof pattern !== "string") {
    throw appError("validation", "like requires a string pattern");
  }
  if (pattern.length > LIKE_MAX_LEN_) {
    throw appError("validation", "like pattern too long");
  }
  let wildcards = 0;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.charAt(i) === "%") wildcards++;
  }
  if (wildcards > LIKE_MAX_WILDCARDS_) {
    throw appError("validation", "like pattern has too many wildcards");
  }
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^" + escaped.replace(/%/g, ".*").replace(/_/g, ".") + "$");
  return function (cell) { return re.test(String(cell)); };
}

function buildOpPredicate_(op, opValue, type) {
  if (op === "like") return likePredicate_(opValue);

  if (op === "in" || op === "nin") {
    if (!Array.isArray(opValue) || opValue.length === 0) {
      throw appError("bad_request", "empty in/nin");
    }
    const wantMatch = (op === "in");
    return function (cell) {
      for (let i = 0; i < opValue.length; i++) {
        if (cmp_(cell, opValue[i], type) === 0) return wantMatch;
      }
      return !wantMatch;
    };
  }

  // eq / ne / gt / gte / lt / lte
  return function (cell) {
    const c = cmp_(cell, opValue, type);
    switch (op) {
      case "eq":  return c === 0;
      case "ne":  return c !== 0;
      case "gt":  return c >  0;
      case "gte": return c >= 0;
      case "lt":  return c <  0;
      case "lte": return c <= 0;
    }
    return false;
  };
}

// Compile a `where` object into a row-level predicate `(obj) => boolean`.
// Per-clause work (operator validation, regex compilation, type lookup)
// happens once here so the row scan stays tight.
function buildMatcher_(where, typeOf) {
  const fieldPreds = [];
  for (const field in where) {
    if (!Object.prototype.hasOwnProperty.call(where, field)) continue;
    const clause = where[field];
    const type = (typeOf && typeOf[field]) || "string";

    if (isOperators_(clause)) {
      const opPreds = [];
      for (const op in clause) {
        if (!Object.prototype.hasOwnProperty.call(clause, op)) continue;
        if (!Object.prototype.hasOwnProperty.call(OPERATORS_, op)) {
          throw appError("bad_request", "unknown operator: " + op);
        }
        opPreds.push(buildOpPredicate_(op, clause[op], type));
      }
      // Empty operator object → no constraint on this field.
      fieldPreds.push(function (obj) {
        const cell = obj[field];
        for (let i = 0; i < opPreds.length; i++) {
          if (!opPreds[i](cell)) return false;
        }
        return true;
      });
    } else {
      // Primitive shorthand: equality.
      const pred = buildOpPredicate_("eq", clause, type);
      fieldPreds.push(function (obj) { return pred(obj[field]); });
    }
  }
  return function matcher(obj) {
    for (let i = 0; i < fieldPreds.length; i++) {
      if (!fieldPreds[i](obj)) return false;
    }
    return true;
  };
}

function matchesWhere(obj, where, typeOf) {
  return buildMatcher_(where || {}, typeOf || {})(obj);
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
  const typeOf = {};
  tableSchema(table).forEach(c => { typeOf[c.column] = c.type; });
  const matcher = buildMatcher_(where || {}, typeOf);
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const obj = rowToObj(header, values[i]);
    if (matcher(obj)) out.push(obj);
  }
  return out;
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
