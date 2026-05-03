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

    // Client predicate on _userIdentifier is honored under v2 (the security
    // gate is the user-predicate, not a where-clause clamp). Alice has no
    // accessible rows owned by bob, so the result is empty either way.
    check("alice _userIdentifier=bob returns 0 (no bob-owned rows in scope)", () => {
      const rows = select(tableName, { _userIdentifier: "bob@test" }, userA);
      if (rows.length !== 0) throw new Error("expected 0 rows, got " + rows.length);
    });

    check("alice _userIdentifier={in:[bob]} returns 0 (no bob-owned rows in scope)", () => {
      const rows = select(tableName, { _userIdentifier: { in: ["bob@test"] } }, userA);
      if (rows.length !== 0) throw new Error("expected 0 rows, got " + rows.length);
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

/**
 * End-to-end test of `_sharedWith` row sharing. Provisions a temp table
 * with both `_userIdentifier` and `_sharedWith`, exercises every share
 * surface (inline-on-insert, standalone share/unshare, inline-on-update),
 * the three perm tiers, dormant shares to non-allowlisted emails, and the
 * anti-enumeration guard. Cleans up in `finally`.
 */
function runRowSharingTest_() {
  _schemaCache = null;
  const userA = { email: "alice@test", name: "Alice" };
  const userB = { email: "bob@test",   name: "Bob"   };
  const userC = { email: "carol@test", name: "Carol" };
  const tableName = "sharingTest" + Utilities.getUuid().replace(/-/g, "").slice(0, 8);

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

  const metaHeader = metaSheet.getRange(1, 1, 1, metaSheet.getLastColumn())
    .getValues()[0].map(s => String(s).trim());
  const metaRow = function (obj) {
    return metaHeader.map(h => obj[h] !== undefined ? obj[h] : "");
  };

  try {
    sheet = ss().insertSheet(tableName);
    sheet.appendRow(["id", "createdAt", "title", "_userIdentifier", "_sharedWith"]);

    const cols = [
      { table: tableName, column: "id",              type: "string",   required: "TRUE",  unique: "TRUE",  default: "auto" },
      { table: tableName, column: "createdAt",       type: "datetime", required: "TRUE",  unique: "FALSE", default: "now"  },
      { table: tableName, column: "title",           type: "string",   required: "TRUE",  unique: "FALSE", default: ""     },
      { table: tableName, column: "_userIdentifier", type: "string",   required: "TRUE",  unique: "FALSE", default: ""     },
      { table: tableName, column: "_sharedWith",     type: "string",   required: "FALSE", unique: "FALSE", default: ""     }
    ];
    cols.forEach(c => { metaSheet.appendRow(metaRow(c)); metaRowsAdded++; });
    _schemaCache = null;

    // 1. Insert with inline shareWith → bob has READ.
    const r1 = insert(tableName, { title: "shared note" }, userA, {
      shareWith: [{ email: "bob@test", perm: "READ" }]
    });
    check("inline shareWith on insert stores entry", () => {
      const shares = JSON.parse(r1._sharedWith);
      if (shares.length !== 1) throw new Error("len: " + shares.length);
      if (shares[0].email !== "bob@test" || shares[0].perm !== "READ") {
        throw new Error("entry: " + JSON.stringify(shares[0]));
      }
    });

    // 2. Bob can SELECT the shared row.
    check("bob's select includes alice's row shared READ", () => {
      const rows = select(tableName, {}, userB);
      if (rows.length !== 1 || rows[0].id !== r1.id) {
        throw new Error("got: " + JSON.stringify(rows.map(r => r.id)));
      }
    });

    // 3. Bob with READ cannot UPDATE.
    expectThrowsWithCode("bob with READ cannot update -> not_found",
      function () { update(tableName, r1.id, { title: "hijacked" }, userB); },
      "not_found");

    // 4. Bob with READ cannot DELETE.
    expectThrowsWithCode("bob with READ cannot delete -> not_found",
      function () { remove(tableName, r1.id, userB); },
      "not_found");

    // 5. Alice upgrades bob to WRITE via standalone share.
    const r1afterShare = share(tableName, r1.id, "bob@test", "WRITE", userA);
    check("standalone share upserts bob to WRITE", () => {
      const shares = JSON.parse(r1afterShare._sharedWith);
      if (shares.length !== 1 || shares[0].perm !== "WRITE") {
        throw new Error("shares: " + r1afterShare._sharedWith);
      }
    });

    // 6. Bob with WRITE can UPDATE data.
    const r1updated = update(tableName, r1.id, { title: "renamed by bob" }, userB);
    check("bob with WRITE can update data", () => {
      if (r1updated.title !== "renamed by bob") throw new Error("title: " + r1updated.title);
    });

    // 7. Bob with WRITE attempting share-management → unauthorized.
    expectThrowsWithCode("bob with WRITE cannot manage shares via update",
      function () {
        update(tableName, r1.id, { title: "x" }, userB, {
          shareWith: [{ email: "carol@test", perm: "READ" }]
        });
      }, "unauthorized");
    expectThrowsWithCode("bob with WRITE cannot unshare via update",
      function () {
        update(tableName, r1.id, {}, userB, { unshareWith: ["carol@test"] });
      }, "unauthorized");

    // 8. Bob with WRITE still cannot DELETE.
    expectThrowsWithCode("bob with WRITE cannot delete -> not_found",
      function () { remove(tableName, r1.id, userB); },
      "not_found");

    // 9. Alice upgrades bob to WRITE_DELETE.
    share(tableName, r1.id, "bob@test", "WRITE_DELETE", userA);
    check("share is idempotent upsert (still 1 entry)", () => {
      const cur = select(tableName, { id: r1.id }, userA);
      const shares = JSON.parse(cur[0]._sharedWith);
      if (shares.length !== 1 || shares[0].perm !== "WRITE_DELETE") {
        throw new Error("shares: " + cur[0]._sharedWith);
      }
    });

    // 10. Bob with WRITE_DELETE can DELETE.
    remove(tableName, r1.id, userB);
    check("bob with WRITE_DELETE can delete", () => {
      const rowsA = select(tableName, {}, userA);
      const rowsB = select(tableName, {}, userB);
      if (rowsA.length !== 0 || rowsB.length !== 0) {
        throw new Error("alice: " + rowsA.length + ", bob: " + rowsB.length);
      }
    });

    // 11. Dormant share — non-allowlisted email accepted.
    const r2 = insert(tableName, { title: "dormant" }, userA, {
      shareWith: [{ email: "ghost@nowhere.invalid", perm: "READ" }]
    });
    check("dormant share with non-allowlisted email is stored", () => {
      const shares = JSON.parse(r2._sharedWith);
      if (shares.length !== 1 || shares[0].email !== "ghost@nowhere.invalid") {
        throw new Error("shares: " + r2._sharedWith);
      }
    });

    // 12. Self-share is rejected.
    expectThrowsWithCode("self-share rejected",
      function () { share(tableName, r2.id, "alice@test", "WRITE", userA); },
      "validation");

    // 13. Bad perm rejected.
    expectThrowsWithCode("bad perm rejected",
      function () { share(tableName, r2.id, "bob@test", "FULL", userA); },
      "validation");

    // 14. Malformed email rejected.
    expectThrowsWithCode("malformed email rejected",
      function () { share(tableName, r2.id, "not-an-email", "READ", userA); },
      "validation");

    // 15. Carol (no share, no ownership) cannot update or delete.
    expectThrowsWithCode("carol no-share update -> not_found",
      function () { update(tableName, r2.id, { title: "hijack" }, userC); },
      "not_found");
    expectThrowsWithCode("carol no-share delete -> not_found",
      function () { remove(tableName, r2.id, userC); },
      "not_found");

    // 16. Carol cannot enumerate via _sharedWith predicate.
    insert(tableName, { title: "carol-own" }, userC); // give carol a baseline row
    check("client _sharedWith predicate is dropped (anti-enumeration)", () => {
      const rows = select(tableName, { _sharedWith: { like: "%bob%" } }, userC);
      // Carol should see only her own row(s); the _sharedWith filter is silently
      // removed. Without the drop, this would either return rows mentioning bob
      // or apply the matcher to carol's empty _sharedWith and return nothing.
      for (const r of rows) {
        if (normalizeEmail_(r._userIdentifier) !== "carol@test") {
          throw new Error("leaked non-carol row: " + r.id);
        }
      }
    });

    // 17. Non-owner share/unshare returns not_found (anti-enumeration).
    expectThrowsWithCode("non-owner share -> not_found",
      function () { share(tableName, r2.id, "x@y", "READ", userC); },
      "not_found");
    expectThrowsWithCode("non-owner unshare -> not_found",
      function () { unshare(tableName, r2.id, "ghost@nowhere.invalid", userC); },
      "not_found");

    // 18. Alice unshare(ghost) — entry removed; bob still not visible (was never shared on r2).
    const r2afterUnshare = unshare(tableName, r2.id, "ghost@nowhere.invalid", userA);
    check("unshare removes entry", () => {
      const shares = JSON.parse(r2afterUnshare._sharedWith || "[]");
      if (shares.length !== 0) throw new Error("shares: " + r2afterUnshare._sharedWith);
    });

    // 19. Inline unshareWith on update — alice shares then revokes via update opts.
    share(tableName, r2.id, "bob@test", "READ", userA);
    update(tableName, r2.id, {}, userA, { unshareWith: ["bob@test"] });
    check("inline unshareWith on update removes share", () => {
      const rows = select(tableName, { id: r2.id }, userA);
      const shares = JSON.parse(rows[0]._sharedWith || "[]");
      if (shares.length !== 0) throw new Error("shares: " + rows[0]._sharedWith);
    });

    // 20. Inline shareWith on update (owner) — adds bob back.
    update(tableName, r2.id, {}, userA, {
      shareWith: [{ email: "bob@test", perm: "WRITE" }]
    });
    check("inline shareWith on update adds entry", () => {
      const rowsB = select(tableName, { id: r2.id }, userB);
      if (rowsB.length !== 1) throw new Error("bob can't see r2: " + rowsB.length);
    });

    // 21. Insert that tries to set _userIdentifier or _sharedWith directly is stripped.
    const r3 = insert(tableName, {
      title: "spoof",
      _userIdentifier: "evil@x",
      _sharedWith: '[{"email":"evil@x","perm":"WRITE_DELETE"}]'
    }, userA);
    check("insert strips client-supplied _userIdentifier / _sharedWith", () => {
      if (r3._userIdentifier !== "alice@test") {
        throw new Error("owner: " + r3._userIdentifier);
      }
      const shares = JSON.parse(r3._sharedWith || "[]");
      if (shares.length !== 0) throw new Error("shares: " + r3._sharedWith);
    });

    // 22. Bob's update via patch attempting to write _sharedWith is stripped.
    update(tableName, r2.id, { title: "bob renamed" }, userB);
    check("non-owner patch is data-only (shares unchanged)", () => {
      const rows = select(tableName, { id: r2.id }, userA);
      const shares = JSON.parse(rows[0]._sharedWith || "[]");
      if (shares.length !== 1 || shares[0].email !== "bob@test") {
        throw new Error("shares unexpectedly changed: " + rows[0]._sharedWith);
      }
      if (rows[0].title !== "bob renamed") throw new Error("title: " + rows[0].title);
    });

    console.log("row sharing test: " + passed + " passed, " + failed + " failed");
    if (failed > 0) throw new Error("row sharing test failures: " + failed);
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
