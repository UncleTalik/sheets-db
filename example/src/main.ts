import {
  createClient,
  SheetsDBError,
  type Where,
  type WhereOperators,
} from "@UncleTalik/sheetsdb-client";
import {
  EXPENSES_SCHEMA,
  NOTES_SCHEMA,
  type Expense,
  type Note,
  type NoteInput,
  type ParsedShare,
  type Permission,
} from "./types.js";

const webAppUrl = import.meta.env.VITE_SHEETSDB_URL;
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

if (!webAppUrl || !googleClientId) {
  document.body.innerHTML =
    "<h1>Missing config</h1><p>Copy <code>.env.example</code> to <code>.env.local</code> and fill in <code>VITE_SHEETSDB_URL</code> and <code>VITE_GOOGLE_CLIENT_ID</code>.</p>";
  throw new Error("missing env vars");
}

const db = createClient({ webAppUrl, googleClientId });
const expenses = db.table<Expense>("expenses");
const notes = db.table<Note>("notes");

if (import.meta.env.DEV) {
  (window as unknown as { db: typeof db }).db = db;
}

const $ = <T extends Element = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

const userLabel = $<HTMLSpanElement>("#user");
const signInBtn = $<HTMLButtonElement>("#sign-in");
const signOutBtn = $<HTMLButtonElement>("#sign-out");
const form = $<HTMLFormElement>("#add-form");
const filterForm = $<HTMLFormElement>("#filter-form");
const filterClearBtn = $<HTMLButtonElement>("#filter-clear");
const list = $<HTMLUListElement>("#list");
const errorBox = $<HTMLDivElement>("#error");
const setupBox = $<HTMLDivElement>("#setup");
const setupRunBtn = $<HTMLButtonElement>("#setup-run");
const notesSection = $<HTMLElement>("#notes-section");
const notesAddForm = $<HTMLFormElement>("#notes-add-form");
const notesList = $<HTMLUListElement>("#notes-list");

let currentFilter: Where = {};

function showError(message: string) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function setSignedIn(email: string) {
  userLabel.textContent = email;
  signInBtn.hidden = true;
  signOutBtn.hidden = false;
}

function setSignedOut() {
  userLabel.textContent = "Not signed in";
  signInBtn.hidden = false;
  signOutBtn.hidden = true;
  form.hidden = true;
  filterForm.hidden = true;
  setupBox.hidden = true;
  notesSection.hidden = true;
  list.innerHTML = "";
  notesList.innerHTML = "";
}

function showSetup() {
  setupBox.hidden = false;
  form.hidden = true;
  filterForm.hidden = true;
  notesSection.hidden = true;
  list.innerHTML = "";
  notesList.innerHTML = "";
}

function showReady() {
  setupBox.hidden = true;
  form.hidden = false;
  filterForm.hidden = false;
  notesSection.hidden = false;
}

function buildFilterFromForm(formEl: HTMLFormElement): Where {
  const data = new FormData(formEl);
  const get = (k: string) => String(data.get(k) ?? "").trim();
  const csv = (k: string) =>
    get(k).split(",").map((s) => s.trim()).filter(Boolean);

  const where: Where = {};

  const catOps: WhereOperators = {};
  if (get("cat-eq")) catOps.eq = get("cat-eq");
  if (get("cat-ne")) catOps.ne = get("cat-ne");
  if (csv("cat-in").length) catOps.in = csv("cat-in");
  if (csv("cat-nin").length) catOps.nin = csv("cat-nin");
  if (Object.keys(catOps).length) where.category = catOps;

  const amtOps: WhereOperators = {};
  if (get("amt-gt")  !== "") amtOps.gt  = Number(get("amt-gt"));
  if (get("amt-gte") !== "") amtOps.gte = Number(get("amt-gte"));
  if (get("amt-lt")  !== "") amtOps.lt  = Number(get("amt-lt"));
  if (get("amt-lte") !== "") amtOps.lte = Number(get("amt-lte"));
  if (Object.keys(amtOps).length) where.amount = amtOps;

  if (get("note-like")) where.note = { like: get("note-like") };

  // Dates from <input type="date"> are YYYY-MM-DD; widen to a full UTC day.
  const dateOps: WhereOperators = {};
  if (get("date-from")) dateOps.gte = new Date(get("date-from") + "T00:00:00Z").toISOString();
  if (get("date-to"))   dateOps.lte = new Date(get("date-to")   + "T23:59:59.999Z").toISOString();
  if (Object.keys(dateOps).length) where.createdAt = dateOps;

  return where;
}

function handleError(err: unknown) {
  if (err instanceof SheetsDBError) {
    showError(`[${err.code}] ${err.details ?? err.message}`);
  } else {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function refresh() {
  clearError();
  // Kick off notes in parallel — independent of the expenses select, so
  // there's no reason to make the user wait for two sequential round-trips.
  // refreshNotes has its own error handling; await it after expenses render
  // so a notes failure doesn't mask an expenses error.
  const notesP = refreshNotes();
  try {
    const rows = await expenses.where(currentFilter).select();
    showReady();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    list.innerHTML = "";
    for (const row of rows) {
      const li = document.createElement("li");
      const amount = document.createElement("span");
      amount.className = "amount";
      amount.textContent = `$${Number(row.amount).toFixed(2)}`;
      const category = document.createElement("span");
      category.className = "category";
      category.textContent = row.note ? `${row.category} — ${row.note}` : row.category;
      const del = document.createElement("button");
      del.className = "delete";
      del.textContent = "×";
      del.title = "Delete";
      del.addEventListener("click", async () => {
        try {
          await expenses.delete(row.id);
          await refresh();
        } catch (err) {
          handleError(err);
        }
      });
      li.append(amount, category, del);
      list.appendChild(li);
    }
    await notesP;
  } catch (err) {
    if (err instanceof SheetsDBError && err.code === "not_found") {
      showSetup();
      return;
    }
    handleError(err);
  }
}

function parseShares(raw: string | undefined): ParsedShare[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as ParsedShare[];
  } catch {
    return [];
  }
}

function lower(s: string | undefined): string {
  return String(s ?? "").trim().toLowerCase();
}

const ALL_PERMS: Permission[] = ["READ", "WRITE", "WRITE_DELETE"];

// Validate untrusted form input before handing it to the typed client API.
// The server rejects bad values with `validation` regardless, but rejecting
// up front avoids a wasted round-trip and surfaces a clean default in the UI.
function asPermission(s: unknown): Permission {
  return ALL_PERMS.includes(s as Permission) ? (s as Permission) : "READ";
}

async function refreshNotes() {
  try {
    const rows = await notes.select();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    notesList.innerHTML = "";
    const me = lower(db.currentUser()?.email);
    for (const row of rows) {
      notesList.appendChild(renderNoteItem(row, me));
    }
  } catch (err) {
    // The `notes` table may not exist yet (older provisioned spreadsheets).
    // Don't surface that as a hard error — the setup banner already prompts
    // the user to provision, which adds `notes` alongside `expenses`.
    if (err instanceof SheetsDBError && err.code === "not_found") {
      notesSection.hidden = true;
      return;
    }
    handleError(err);
  }
}

function renderNoteItem(row: Note, me: string): HTMLLIElement {
  const ownerEmail = lower(row._userIdentifier);
  const isOwner = ownerEmail === me;
  const shares = parseShares(row._sharedWith);
  const myShare = isOwner ? null : shares.find((s) => lower(s.email) === me) ?? null;
  const canDelete = isOwner || myShare?.perm === "WRITE_DELETE";

  const li = document.createElement("li");

  const row1 = document.createElement("div");
  row1.className = "row1";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = row.title;
  const body = document.createElement("span");
  body.className = "body";
  body.textContent = row.body ?? "";
  row1.append(title, body);
  li.appendChild(row1);

  const actions = document.createElement("div");
  actions.className = "actions";
  if (canDelete) {
    const del = document.createElement("button");
    del.className = "delete";
    del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("click", async () => {
      try {
        await notes.delete(row.id);
        await refreshNotes();
      } catch (err) {
        handleError(err);
      }
    });
    actions.appendChild(del);
  }
  li.appendChild(actions);

  const shareRow = document.createElement("div");
  shareRow.className = "share-row";

  if (!isOwner) {
    // Visible to a collaborator: show whose row this is and what they can do.
    const ownerBadge = document.createElement("span");
    ownerBadge.className = "badge owner";
    ownerBadge.textContent = `owner: ${row._userIdentifier}`;
    shareRow.appendChild(ownerBadge);
    if (myShare) {
      const permBadge = document.createElement("span");
      permBadge.className = "badge perm";
      permBadge.textContent = `you: ${myShare.perm}`;
      shareRow.appendChild(permBadge);
    }
  }

  // Show the share list to anyone who can see the row — collaborators benefit
  // from seeing who else has access. Revoke buttons are owner-only.
  for (const share of shares) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = `${share.email} · ${share.perm}`;
    if (isOwner) {
      const x = document.createElement("button");
      x.className = "x";
      x.textContent = "×";
      x.title = `Revoke share with ${share.email}`;
      x.addEventListener("click", async () => {
        try {
          await notes.unshare(row.id, share.email);
          await refreshNotes();
        } catch (err) {
          handleError(err);
        }
      });
      badge.appendChild(x);
    }
    shareRow.appendChild(badge);
  }

  if (isOwner) {
    shareRow.appendChild(buildShareForm(row.id));
  }

  li.appendChild(shareRow);
  return li;
}

function buildShareForm(noteId: string): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "share-form";

  const emailInput = document.createElement("input");
  emailInput.type = "email";
  emailInput.placeholder = "share with…";
  emailInput.required = true;

  const permSelect = document.createElement("select");
  for (const p of ["READ", "WRITE", "WRITE_DELETE"] as const) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    permSelect.appendChild(opt);
  }

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "+ share";

  form.append(emailInput, permSelect, submit);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    if (!email) return;
    const perm = asPermission(permSelect.value);
    try {
      await notes.share(noteId, email, perm);
      await refreshNotes();
    } catch (err) {
      handleError(err);
    }
  });
  return form;
}

async function demoSystemTableGuard() {
  // System tables (`_meta`, `_allowlist`, any `_*` name) are blocked from
  // the RPC API by the client guard (>=0.3.0) and backend (>=1.1.0). This
  // dev-only sanity check proves the rejection at runtime — useful as a
  // regression smoke test when bumping either side.
  try {
    await db.table("_meta").select();
    console.warn("[demo] expected system-table rejection, but read succeeded");
  } catch (err) {
    if (err instanceof SheetsDBError && err.code === "unauthorized") {
      console.info(
        `[demo] system-table guard rejected db.table("_meta").select(): ${err.code} — ${err.details ?? err.message}`,
      );
    } else {
      console.warn("[demo] system-table guard threw unexpected error:", err);
    }
  }
}

signInBtn.addEventListener("click", async () => {
  clearError();
  try {
    const user = await db.signIn();
    setSignedIn(user.email);
    if (import.meta.env.DEV) {
      await demoSystemTableGuard();
    }
    await refresh();
  } catch (err) {
    handleError(err);
  }
});

signOutBtn.addEventListener("click", () => {
  db.signOut();
  setSignedOut();
});

setupRunBtn.addEventListener("click", async () => {
  clearError();
  setupRunBtn.disabled = true;
  const originalLabel = setupRunBtn.textContent;
  setupRunBtn.textContent = "Creating…";
  try {
    await db.provision({
      tables: { expenses: EXPENSES_SCHEMA, notes: NOTES_SCHEMA },
    });
    await refresh();
  } catch (err) {
    handleError(err);
  } finally {
    setupRunBtn.disabled = false;
    setupRunBtn.textContent = originalLabel;
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();
  const data = new FormData(form);
  const amount = Number(data.get("amount"));
  const category = String(data.get("category") ?? "").trim();
  const note = String(data.get("note") ?? "").trim();
  if (!category || Number.isNaN(amount)) return;
  try {
    await expenses.insert({
      amount,
      category,
      ...(note ? { note } : {}),
    });
    form.reset();
    await refresh();
  } catch (err) {
    handleError(err);
  }
});

filterForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  currentFilter = buildFilterFromForm(filterForm);
  await refresh();
});

filterClearBtn.addEventListener("click", async () => {
  filterForm.reset();
  currentFilter = {};
  await refresh();
});

notesAddForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();
  const data = new FormData(notesAddForm);
  const title = String(data.get("title") ?? "").trim();
  const body = String(data.get("body") ?? "").trim();
  if (!title) return;
  // Server stamps `_userIdentifier` from the verified caller — clients omit it.
  const input: NoteInput = body ? { title, body } : { title };
  // Optional inline shareWith — saves a follow-up `.share()` round-trip.
  const shareEmail = String(data.get("share-email") ?? "").trim();
  const sharePerm = asPermission(data.get("share-perm"));
  const opts = shareEmail
    ? { shareWith: [{ email: shareEmail, perm: sharePerm }] }
    : undefined;
  try {
    await notes.insert(input, opts);
    notesAddForm.reset();
    await refreshNotes();
  } catch (err) {
    handleError(err);
  }
});
