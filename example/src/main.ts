import {
  createClient,
  SheetsDBError,
  type Where,
  type WhereOperators,
} from "@UncleTalik/sheetsdb-client";
import { EXPENSES_SCHEMA, type Expense } from "./types.js";

const webAppUrl = import.meta.env.VITE_SHEETSDB_URL;
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

if (!webAppUrl || !googleClientId) {
  document.body.innerHTML =
    "<h1>Missing config</h1><p>Copy <code>.env.example</code> to <code>.env.local</code> and fill in <code>VITE_SHEETSDB_URL</code> and <code>VITE_GOOGLE_CLIENT_ID</code>.</p>";
  throw new Error("missing env vars");
}

const db = createClient({ webAppUrl, googleClientId });
const expenses = db.table<Expense>("expenses");

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
  list.innerHTML = "";
}

function showSetup() {
  setupBox.hidden = false;
  form.hidden = true;
  filterForm.hidden = true;
  list.innerHTML = "";
}

function showReady() {
  setupBox.hidden = true;
  form.hidden = false;
  filterForm.hidden = false;
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
  } catch (err) {
    if (err instanceof SheetsDBError && err.code === "not_found") {
      showSetup();
      return;
    }
    handleError(err);
  }
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
    await db.provision({ tables: { expenses: EXPENSES_SCHEMA } });
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
