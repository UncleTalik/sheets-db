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
