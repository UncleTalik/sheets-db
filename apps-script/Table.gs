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

function isRowScoped_(header) {
  return header.indexOf(MAGIC_COL_USER_ID_) >= 0;
}

// Resolve and normalize the caller's identity for a row-scoped op. Throws
// `unauthorized` if the caller is missing — defense-in-depth against future
// callers that forget to thread `user` through.
function callerEmail_(user) {
  if (!user || !user.email) {
    throw appError("unauthorized", "row-scoped table requires an authenticated user");
  }
  return normalizeEmail_(user.email);
}

// Mismatch returns `not_found` (not `unauthorized`) so callers can't
// enumerate which IDs exist across owners.
function assertRowOwnership_(row, callerEmail, id) {
  if (normalizeEmail_(row[MAGIC_COL_USER_ID_]) !== callerEmail) {
    throw appError("not_found", "no row with id=" + id);
  }
}

// Read the current contents of a row identified by row index (1-based).
function readRowAt_(sheet, rowIdx, header) {
  return rowToObj(header, sheet.getRange(rowIdx, 1, 1, header.length).getValues()[0]);
}

// Write a row object back to the sheet at rowIdx, projected through the header.
function writeRowAt_(sheet, rowIdx, header, obj) {
  sheet.getRange(rowIdx, 1, 1, header.length)
    .setValues([header.map(col => toCell(obj[col]))]);
}

function select(table, where, user) {
  const sheet = getSheet(table);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues();
  const header = values.shift().map(String);
  const typeOf = {};
  tableSchema(table).forEach(c => { typeOf[c.column] = c.type; });

  let userPredicate = null;
  if (typeOf[MAGIC_COL_USER_ID_]) {
    const me = callerEmail_(user);
    const hasShares = !!typeOf[MAGIC_COL_SHARED_WITH_];
    userPredicate = function (row) {
      if (normalizeEmail_(row[MAGIC_COL_USER_ID_]) === me) return true;
      if (!hasShares) return false;
      return sharedPermFor_(row, me) !== null;
    };
    // Anti-enumeration: drop any client predicate referencing _sharedWith.
    if (where && Object.prototype.hasOwnProperty.call(where, MAGIC_COL_SHARED_WITH_)) {
      where = Object.assign({}, where);
      delete where[MAGIC_COL_SHARED_WITH_];
    }
  }

  const matcher = buildMatcher_(where || {}, typeOf);
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const obj = rowToObj(header, values[i]);
    // Cheap matcher first; userPredicate parses the _sharedWith JSON per row,
    // so it's strictly more expensive — let the matcher reject early.
    if (!matcher(obj)) continue;
    if (userPredicate && !userPredicate(obj)) continue;
    out.push(obj);
  }
  return out;
}

function insert(table, row, user, opts) {
  const sheet = getSheet(table);
  const header = getHeader(sheet);
  if (isRowScoped_(header) && row) {
    delete row[MAGIC_COL_USER_ID_];
    delete row[MAGIC_COL_SHARED_WITH_];
  }
  const clean = validateRow(table, row, { user: user, isInsert: true });

  // Inline shareWith on insert: caller becomes the owner, so this is just
  // a convenience batched into the same op (no separate auth needed).
  if (header.indexOf(MAGIC_COL_SHARED_WITH_) >= 0 && opts && opts.shareWith) {
    if (!Array.isArray(opts.shareWith)) {
      throw appError("bad_request", "shareWith must be an array");
    }
    const owner = clean[MAGIC_COL_USER_ID_];
    const shares = opts.shareWith.map(e => validateShareEntry_(e, owner));
    assertNoDuplicateShares_(shares);
    clean[MAGIC_COL_SHARED_WITH_] = serializeShares_(shares);
  }

  sheet.appendRow(header.map(col => toCell(clean[col])));
  return clean;
}

function update(table, id, patch, user, opts) {
  const sheet = getSheet(table);
  const rowIdx = findRowIndexById(sheet, id);
  if (rowIdx < 0) throw appError("not_found", "no row with id=" + id);

  const header = getHeader(sheet);
  const current = readRowAt_(sheet, rowIdx, header);

  let isOwner = false;
  if (isRowScoped_(header)) {
    const me = callerEmail_(user);
    if (normalizeEmail_(current[MAGIC_COL_USER_ID_]) === me) {
      isOwner = true;
    } else {
      const perm = sharedPermFor_(current, me);
      if (perm !== "WRITE" && perm !== "WRITE_DELETE") {
        throw appError("not_found", "no row with id=" + id);
      }
      // Non-owner with WRITE/WRITE_DELETE may not manage the share list.
      if (opts && (opts.shareWith || opts.unshareWith)) {
        throw appError("unauthorized", "only the row owner can manage shares");
      }
    }
    // Server-managed columns are untouchable via the patch — owner uses opts,
    // collaborators have no business writing them. Strip in both cases.
    delete patch[MAGIC_COL_USER_ID_];
    delete patch[MAGIC_COL_SHARED_WITH_];
  }

  const merged = Object.assign({}, current, patch, { id });
  if (header.indexOf("updatedAt") >= 0) merged.updatedAt = new Date().toISOString();

  if (isOwner && header.indexOf(MAGIC_COL_SHARED_WITH_) >= 0 && opts) {
    let shares = parseShares_(merged[MAGIC_COL_SHARED_WITH_]);
    if (opts.unshareWith) {
      if (!Array.isArray(opts.unshareWith)) {
        throw appError("bad_request", "unshareWith must be an array");
      }
      for (const email of opts.unshareWith) {
        const norm = normalizeEmail_(email);
        shares = shares.filter(s => normalizeEmail_(s.email) !== norm);
      }
    }
    if (opts.shareWith) {
      if (!Array.isArray(opts.shareWith)) {
        throw appError("bad_request", "shareWith must be an array");
      }
      for (const entry of opts.shareWith) {
        const v = validateShareEntry_(entry, merged[MAGIC_COL_USER_ID_]);
        const idx = findShareIndex_(shares, v.email);
        if (idx >= 0) shares[idx] = v; else shares.push(v);
      }
    }
    merged[MAGIC_COL_SHARED_WITH_] = serializeShares_(shares);
  }

  const clean = validateRow(table, merged, { existingId: id });
  writeRowAt_(sheet, rowIdx, header, clean);
  return clean;
}

function remove(table, id, user) {
  const sheet = getSheet(table);
  const rowIdx = findRowIndexById(sheet, id);
  if (rowIdx < 0) throw appError("not_found", "no row with id=" + id);
  const header = getHeader(sheet);
  if (isRowScoped_(header)) {
    const me = callerEmail_(user);
    const current = readRowAt_(sheet, rowIdx, header);
    if (normalizeEmail_(current[MAGIC_COL_USER_ID_]) !== me) {
      // Only WRITE_DELETE collaborators can delete; WRITE alone cannot.
      if (sharedPermFor_(current, me) !== "WRITE_DELETE") {
        throw appError("not_found", "no row with id=" + id);
      }
    }
  }
  sheet.deleteRow(rowIdx);
  return { id };
}

// --- Share / unshare ops --------------------------------------------------

function requireSharingTable_(header) {
  if (!isRowScoped_(header)) {
    throw appError("bad_request", "table is not row-scoped (missing _userIdentifier)");
  }
  if (header.indexOf(MAGIC_COL_SHARED_WITH_) < 0) {
    throw appError("bad_request", "table does not have a _sharedWith column");
  }
}

// Owner-only mutation scaffolding for sharing-capable tables. Loads the row,
// asserts ownership, runs `mutate(current, header)` in-place, bumps
// `updatedAt` if the schema has it, writes back, returns the updated row.
function mutateOwnedRow_(table, id, user, mutate) {
  const sheet = getSheet(table);
  const header = getHeader(sheet);
  requireSharingTable_(header);
  const rowIdx = findRowIndexById(sheet, id);
  if (rowIdx < 0) throw appError("not_found", "no row with id=" + id);
  const current = readRowAt_(sheet, rowIdx, header);
  assertRowOwnership_(current, callerEmail_(user), id);
  mutate(current, header);
  if (header.indexOf("updatedAt") >= 0) {
    current.updatedAt = new Date().toISOString();
  }
  writeRowAt_(sheet, rowIdx, header, current);
  return current;
}

function share(table, id, email, perm, user) {
  return mutateOwnedRow_(table, id, user, function (current) {
    const entry = validateShareEntry_({ email: email, perm: perm },
                                      current[MAGIC_COL_USER_ID_]);
    const shares = parseShares_(current[MAGIC_COL_SHARED_WITH_]);
    const idx = findShareIndex_(shares, entry.email);
    if (idx >= 0) shares[idx] = entry; else shares.push(entry);
    current[MAGIC_COL_SHARED_WITH_] = serializeShares_(shares);
  });
}

function unshare(table, id, email, user) {
  // Validate before the lock + sheet load — empty email is always wrong.
  const norm = normalizeEmail_(email);
  if (!norm) throw appError("validation", "email required");
  return mutateOwnedRow_(table, id, user, function (current) {
    const shares = parseShares_(current[MAGIC_COL_SHARED_WITH_])
      .filter(s => normalizeEmail_(s.email) !== norm);
    current[MAGIC_COL_SHARED_WITH_] = serializeShares_(shares);
  });
}

function toCell(v) {
  // Sheets prefers primitives; undefined/null become empty strings.
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v;
  return v;
}
