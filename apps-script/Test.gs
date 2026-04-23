/**
 * Run this from the editor (Run > runSmokeTest) after filling in _meta,
 * _allowlist, and creating a test sheet. It bypasses auth by calling the
 * CRUD functions directly. Useful for sanity-checking schema + validation.
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
