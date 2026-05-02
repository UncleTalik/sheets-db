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
