/**
 * Run this from the editor (Run > runSmokeTest) after filling in _meta,
 * _allowlist, and creating a test sheet. It bypasses auth by calling the
 * CRUD functions directly. Useful for sanity-checking schema + validation.
 *
 * To verify the system-table guard end-to-end (after deploy), curl the
 * /exec URL with a valid idToken for an allowlisted user. Each of these
 * should respond { ok: false, error: "unauthorized", details: "table _* is reserved..." }:
 *
 *   {"idToken":"...","op":"select","table":"_meta"}
 *   {"idToken":"...","op":"select","table":"_allowlist"}
 *   {"idToken":"...","op":"insert","table":"_meta","row":{"table":"x","column":"y","type":"string"}}
 *   {"idToken":"...","op":"update","table":"_allowlist","id":"x","row":{"email":"e@x"}}
 *   {"idToken":"...","op":"delete","table":"_meta","id":"x"}
 *
 * And as OWNER_EMAIL, this should respond { ok: false, error: "validation", ... }:
 *
 *   {"idToken":"...","op":"provision","spec":{"tables":{"_audit":[{"column":"id","type":"string"}]}}}
 */
function runSmokeTest() {
  _schemaCache = null; // reset
  const fakeUser = { email: "smoke@test", name: "Smoke" };

  const created = insert("expenses", { amount: 12.5, category: "groceries", note: "test" }, fakeUser);
  console.log("inserted:", created);

  console.log("eq:",    select("expenses", { category: "groceries" }).length, "rows");
  console.log("ne:",    select("expenses", { category: { ne: "rent" } }).length, "rows");
  console.log("gt:",    select("expenses", { amount: { gt: 10 } }).length, "rows");
  console.log("range:", select("expenses", { amount: { gte: 5, lte: 50 } }).length, "rows");
  console.log("in:",    select("expenses", { category: { in: ["groceries", "gas"] } }).length, "rows");
  console.log("nin:",   select("expenses", { category: { nin: ["rent"] } }).length, "rows");
  console.log("like:",  select("expenses", { note: { like: "%test%" } }).length, "rows");

  const updated = update("expenses", created.id, { amount: 13.5 }, fakeUser);
  console.log("updated:", updated);

  const removed = remove("expenses", created.id);
  console.log("removed:", removed);
}

/**
 * Pure-JS exercise of buildMatcher_ — no Sheets I/O. Run from the editor
 * (Run > runMatcherUnitTest_) when changing operator semantics.
 */
function runMatcherUnitTest_() {
  const typeOf = {
    amount: "number",
    category: "string",
    note: "string",
    createdAt: "datetime",
    active: "boolean"
  };

  const cases = [
    ["primitive eq match",        { category: "groceries" },                     { category: "groceries" }, true],
    ["primitive eq miss",         { category: "groceries" },                     { category: "rent" },      false],
    ["loose numeric eq",          { amount: 42 },                                { amount: "42" },          true],
    ["operator eq",               { amount: { eq: 5 } },                         { amount: 5 },             true],
    ["operator ne",               { category: { ne: "rent" } },                  { category: "groceries" }, true],
    ["operator gt true",          { amount: { gt: 10 } },                        { amount: 12 },            true],
    ["operator gt boundary",      { amount: { gt: 10 } },                        { amount: 10 },            false],
    ["operator gte boundary",     { amount: { gte: 10 } },                       { amount: 10 },            true],
    ["operator lt boundary",      { amount: { lt: 10 } },                        { amount: 10 },            false],
    ["operator lte boundary",     { amount: { lte: 10 } },                       { amount: 10 },            true],
    ["range gte+lte inside",      { amount: { gte: 5, lte: 50 } },               { amount: 25 },            true],
    ["range gte+lte outside",     { amount: { gte: 5, lte: 50 } },               { amount: 99 },            false],
    ["like prefix wildcard",      { note: { like: "test%" } },                   { note: "test note" },     true],
    ["like suffix wildcard",      { note: { like: "%note" } },                   { note: "test note" },     true],
    ["like single-char wildcard", { note: { like: "te_t" } },                    { note: "test" },          true],
    ["like miss",                 { note: { like: "%xyz%" } },                   { note: "test" },          false],
    ["in match",                  { category: { in: ["groceries", "gas"] } },    { category: "gas" },       true],
    ["in miss",                   { category: { in: ["groceries", "gas"] } },    { category: "rent" },      false],
    ["nin pass",                  { category: { nin: ["rent"] } },               { category: "groceries" }, true],
    ["nin reject",                { category: { nin: ["rent"] } },               { category: "rent" },      false],
    ["datetime ISO gt",           { createdAt: { gt: "2024-01-01T00:00:00.000Z" } },  { createdAt: "2024-06-01T12:00:00.000Z" }, true],
    ["datetime ISO lt false",     { createdAt: { lt: "2024-01-01T00:00:00.000Z" } },  { createdAt: "2024-06-01T12:00:00.000Z" }, false],
    ["boolean eq true",           { active: { eq: true } },                      { active: "true" },        true],
    ["boolean ne false",          { active: { ne: false } },                     { active: true },          true],
    ["empty operators object",    { amount: {} },                                { amount: 5 },             true],
    ["mixed primitive + ops",     { category: "groceries", amount: { gt: 1 } }, { category: "groceries", amount: 5 }, true]
  ];

  let passed = 0, failed = 0;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const label = c[0], where = c[1], obj = c[2], expected = c[3];
    try {
      const actual = matchesWhere(obj, where, typeOf);
      if (actual === expected) passed++;
      else {
        failed++;
        console.error("FAIL [" + label + "] expected " + expected + ", got " + actual);
      }
    } catch (e) {
      failed++;
      console.error("FAIL [" + label + "] threw: " + (e && e.message));
    }
  }

  // Negative paths: malformed `where` should throw with the right code.
  const negatives = [
    ["unknown operator",  function () { matchesWhere({}, { amount: { foo: 1 } }, typeOf); }, "bad_request"],
    ["empty in",          function () { matchesWhere({}, { category: { in: [] } }, typeOf); }, "bad_request"],
    ["like non-string",   function () { matchesWhere({}, { note: { like: 5 } }, typeOf); }, "validation"]
  ];
  for (let i = 0; i < negatives.length; i++) {
    const n = negatives[i];
    const label = n[0], fn = n[1], expectedCode = n[2];
    try {
      fn();
      failed++;
      console.error("FAIL [" + label + "] expected throw, returned");
    } catch (e) {
      if (e && e.code === expectedCode) passed++;
      else {
        failed++;
        console.error("FAIL [" + label + "] expected code " + expectedCode + ", got " + (e && e.code) + " (" + (e && e.message) + ")");
      }
    }
  }

  console.log("matcher unit test: " + passed + " passed, " + failed + " failed");
  if (failed > 0) throw new Error("matcher unit test failures: " + failed);
}

/**
 * End-to-end test of the `_userIdentifier` magic column. Provisions a
 * temporary sheet + matching `_meta` rows, exercises insert/select/update/
 * delete as two distinct users, then cleans up. Run from the editor
 * (Run > runRowAccessControlTest_) after a deploy.
 *
 * If the run aborts mid-way (e.g. you cancel from the editor), re-run it —
 * the test sheet name has a random suffix and the `finally` block deletes
 * the sheet and the appended `_meta` rows. Any garbage from a hard kill is
 * a sheet with prefix `racTest` and trailing `_meta` rows pointing at it.
 */
function runRowAccessControlTest_() {
  _schemaCache = null;
  const userA = { email: "alice@test", name: "Alice" };
  const userB = { email: "bob@test",   name: "Bob" };
  const tableName = "racTest" + Utilities.getUuid().replace(/-/g, "").slice(0, 8);

  let sheet = null;
  let metaRowsAdded = 0;
  let passed = 0, failed = 0;

  function check(label, fn) {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      console.error("FAIL [" + label + "] " + (e && e.message));
    }
  }

  function expectThrowsWithCode(label, fn, expectedCode) {
    try {
      fn();
      failed++;
      console.error("FAIL [" + label + "] expected throw");
    } catch (e) {
      if (e && e.code === expectedCode) {
        passed++;
      } else {
        failed++;
        console.error("FAIL [" + label + "] expected code " + expectedCode +
          ", got " + (e && e.code) + " (" + (e && e.message) + ")");
      }
    }
  }

  const metaSheet = ss().getSheetByName("_meta");
  if (!metaSheet) throw new Error("_meta sheet missing — run bootstrap() first");

  // Build _meta rows in whatever column order this spreadsheet's _meta uses.
  const metaHeader = metaSheet.getRange(1, 1, 1, metaSheet.getLastColumn())
    .getValues()[0].map(s => String(s).trim());
  const metaRow = function (obj) {
    return metaHeader.map(h => obj[h] !== undefined ? obj[h] : "");
  };

  try {
    sheet = ss().insertSheet(tableName);
    sheet.appendRow(["id", "createdAt", "title", "_userIdentifier"]);

    const cols = [
      { table: tableName, column: "id",              type: "string",   required: "TRUE", unique: "TRUE",  default: "auto" },
      { table: tableName, column: "createdAt",       type: "datetime", required: "TRUE", unique: "FALSE", default: "now"  },
      { table: tableName, column: "title",           type: "string",   required: "TRUE", unique: "FALSE", default: ""     },
      { table: tableName, column: "_userIdentifier", type: "string",   required: "TRUE", unique: "FALSE", default: ""     }
    ];
    cols.forEach(c => { metaSheet.appendRow(metaRow(c)); metaRowsAdded++; });

    _schemaCache = null; // force re-read so the new table is visible

    // Insert as Alice — server stamps owner.
    const aliceRow = insert(tableName, { title: "alice note" }, userA);
    check("insert auto-stamps owner with caller email (lowercased)", () => {
      if (aliceRow._userIdentifier !== "alice@test") {
        throw new Error("expected alice@test, got " + aliceRow._userIdentifier);
      }
    });

    // Insert with a spoofed identifier — server ignores it.
    const spoofRow = insert(tableName, { title: "spoof", _userIdentifier: "evil@x" }, userA);
    check("insert ignores client-supplied _userIdentifier", () => {
      if (spoofRow._userIdentifier !== "alice@test") {
        throw new Error("expected alice@test, got " + spoofRow._userIdentifier);
      }
    });

    // Bob selects: sees nothing.
    check("bob's select returns 0 of alice's rows", () => {
      const rows = select(tableName, {}, userB);
      if (rows.length !== 0) throw new Error("expected 0 rows, got " + rows.length);
    });

    // Alice selects: sees her 2 rows.
    check("alice's select returns her own 2 rows", () => {
      const rows = select(tableName, {}, userA);
      if (rows.length !== 2) throw new Error("expected 2 rows, got " + rows.length);
    });

    // Adversarial primitive override is ignored.
    check("client _userIdentifier=bob in where is ignored for alice", () => {
      const rows = select(tableName, { _userIdentifier: "bob@test" }, userA);
      if (rows.length !== 2) throw new Error("expected 2 rows, got " + rows.length);
    });

    // Adversarial operator-shape override is ignored.
    check("client _userIdentifier={in:[bob]} in where is ignored", () => {
      const rows = select(tableName, { _userIdentifier: { in: ["bob@test"] } }, userA);
      if (rows.length !== 2) throw new Error("expected 2 rows, got " + rows.length);
    });

    // Bob can't update or delete Alice's row — both surface as not_found.
    expectThrowsWithCode("bob update of alice's row -> not_found",
      function () { update(tableName, aliceRow.id, { title: "hijacked" }, userB); },
      "not_found");
    expectThrowsWithCode("bob delete of alice's row -> not_found",
      function () { remove(tableName, aliceRow.id, userB); },
      "not_found");

    // Confirm Bob's failed update did not actually mutate the row.
    check("bob's failed update did not alter alice's row", () => {
      const rows = select(tableName, { id: aliceRow.id }, userA);
      if (rows.length !== 1 || rows[0].title !== "alice note") {
        throw new Error("title became: " + (rows[0] && rows[0].title));
      }
    });

    // Alice updates her row, attempts to rewrite owner — patch is stripped.
    const updated = update(tableName, aliceRow.id,
      { _userIdentifier: "evil@x", title: "renamed" }, userA);
    check("update strips _userIdentifier from patch (alice retains ownership)", () => {
      if (updated._userIdentifier !== "alice@test") {
        throw new Error("owner became: " + updated._userIdentifier);
      }
      if (updated.title !== "renamed") {
        throw new Error("title became: " + updated.title);
      }
    });

    // Alice can delete her own row.
    remove(tableName, aliceRow.id, userA);
    check("alice can delete her own row", () => {
      const rows = select(tableName, {}, userA);
      if (rows.length !== 1) throw new Error("expected 1 row, got " + rows.length);
    });

    // Empty-table select for Bob still 0.
    check("bob still sees 0 rows after alice's delete", () => {
      const rows = select(tableName, {}, userB);
      if (rows.length !== 0) throw new Error("expected 0 rows, got " + rows.length);
    });

    console.log("row access control test: " + passed + " passed, " + failed + " failed");
    if (failed > 0) throw new Error("row access control test failures: " + failed);
  } finally {
    if (sheet) {
      try { ss().deleteSheet(sheet); } catch (e) { console.warn("cleanup sheet:", e && e.message); }
    }
    if (metaRowsAdded > 0) {
      try {
        const lastRow = metaSheet.getLastRow();
        metaSheet.deleteRows(lastRow - metaRowsAdded + 1, metaRowsAdded);
      } catch (e) { console.warn("cleanup _meta rows:", e && e.message); }
    }
    _schemaCache = null;
  }
}
