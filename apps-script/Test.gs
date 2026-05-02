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

  const all = select("expenses", { category: "groceries" });
  console.log("selected:", all.length, "rows");

  const updated = update("expenses", created.id, { amount: 13.5 }, fakeUser);
  console.log("updated:", updated);

  const removed = remove("expenses", created.id);
  console.log("removed:", removed);
}
