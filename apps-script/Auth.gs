/**
 * Verifies a Google ID token via the tokeninfo endpoint, checks audience,
 * email verification status, and allowlist membership.
 * Returns { email, name } on success; throws AppError on failure.
 */
function verifyAuth(idToken) {
  if (!idToken || typeof idToken !== "string") {
    throw appError("unauthorized", "missing idToken");
  }

  const expectedAud = PropertiesService.getScriptProperties().getProperty("OAUTH_CLIENT_ID");
  if (!expectedAud) {
    throw appError("misconfigured", "OAUTH_CLIENT_ID script property not set");
  }

  const url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw appError("unauthorized", "tokeninfo rejected token (" + resp.getResponseCode() + ")");
  }

  const claims = JSON.parse(resp.getContentText());

  // aud must match our OAuth client
  if (claims.aud !== expectedAud) {
    throw appError("unauthorized", "audience mismatch");
  }
  // iss must be Google
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    throw appError("unauthorized", "bad issuer");
  }
  // not expired (tokeninfo returns "exp" in seconds as a string)
  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.exp && Number(claims.exp) < nowSec) {
    throw appError("unauthorized", "token expired");
  }
  // email must be present and verified
  if (!claims.email) throw appError("unauthorized", "no email in token");
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (!verified) throw appError("unauthorized", "email not verified");

  if (!isAllowed(claims.email)) {
    throw appError("unauthorized", "not in allowlist: " + claims.email);
  }

  return { email: claims.email, name: claims.name || "" };
}

function isAllowed(email) {
  const sheet = ss().getSheetByName("_allowlist");
  if (!sheet) throw appError("misconfigured", "_allowlist sheet missing");
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const emails = sheet.getRange(2, 1, last - 1, 1).getValues()
    .flat()
    .map(normalizeEmail_)
    .filter(Boolean);
  return emails.indexOf(normalizeEmail_(email)) >= 0;
}

// Canonical form for any email used as an identity key — auth, allowlist
// membership, and `_userIdentifier` row scoping all compare on this shape.
function normalizeEmail_(email) {
  return String(email == null ? "" : email).trim().toLowerCase();
}
