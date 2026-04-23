/**
 * One-time setup: ensures `_meta` and `_allowlist` exist with their header
 * rows, and seeds `_allowlist` with your email so you can sign in.
 *
 * Run this from the Apps Script editor: Run > bootstrap.
 * Idempotent — safe to re-run.
 */
function bootstrap() {
  const spreadsheet = ss();
  const actions = [];

  if (!spreadsheet.getSheetByName("_meta")) {
    const sheet = spreadsheet.insertSheet("_meta");
    sheet.appendRow(["table", "column", "type", "required", "unique", "default"]);
    sheet.setFrozenRows(1);
    actions.push("created _meta");
  } else {
    actions.push("_meta already exists — skipped");
  }

  const existing = spreadsheet.getSheetByName("_allowlist");
  if (!existing) {
    const sheet = spreadsheet.insertSheet("_allowlist");
    sheet.appendRow(["email", "name"]);
    sheet.setFrozenRows(1);
    let seeded = false;
    try {
      const email = Session.getActiveUser().getEmail();
      if (email) {
        sheet.appendRow([email, "Owner"]);
        actions.push("created _allowlist and seeded with " + email);
        seeded = true;
      }
    } catch (e) {
      // Ignore — fall through to the manual message.
    }
    if (!seeded) {
      actions.push("created _allowlist (could not detect your email — add yourself manually)");
    }
  } else {
    actions.push("_allowlist already exists — skipped");
  }

  console.log("Bootstrap results:");
  actions.forEach(a => console.log("  • " + a));
  console.log("");
  console.log("Next steps:");
  console.log("  1. Project Settings → Script properties → add OAUTH_CLIENT_ID (required for all requests).");
  console.log("  2. Project Settings → Script properties → add OWNER_EMAIL = your email (required to call db.provision()).");
  console.log("  3. Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).");
  console.log("  4. Copy the /exec URL — your frontend needs it as VITE_SHEETSDB_URL.");
}
