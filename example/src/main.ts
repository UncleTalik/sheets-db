import { createClient, SheetsDBError } from "@UncleTalik/sheetsdb-client";
import type { Expense } from "./types.js";

const webAppUrl = import.meta.env.VITE_SHEETSDB_URL;
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

if (!webAppUrl || !googleClientId) {
  document.body.innerHTML =
    "<h1>Missing config</h1><p>Copy <code>.env.example</code> to <code>.env.local</code> and fill in <code>VITE_SHEETSDB_URL</code> and <code>VITE_GOOGLE_CLIENT_ID</code>.</p>";
  throw new Error("missing env vars");
}

const db = createClient({ webAppUrl, googleClientId });
const expenses = db.table<Expense>("expenses");

const $ = <T extends Element = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

const userLabel = $<HTMLSpanElement>("#user");
const signInBtn = $<HTMLButtonElement>("#sign-in");
const signOutBtn = $<HTMLButtonElement>("#sign-out");
const form = $<HTMLFormElement>("#add-form");
const list = $<HTMLUListElement>("#list");
const errorBox = $<HTMLDivElement>("#error");

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
  form.hidden = false;
}

function setSignedOut() {
  userLabel.textContent = "Not signed in";
  signInBtn.hidden = false;
  signOutBtn.hidden = true;
  form.hidden = true;
  list.innerHTML = "";
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
    const rows = await expenses.select();
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
    handleError(err);
  }
}

signInBtn.addEventListener("click", async () => {
  clearError();
  try {
    const user = await db.signIn();
    setSignedIn(user.email);
    await refresh();
  } catch (err) {
    handleError(err);
  }
});

signOutBtn.addEventListener("click", () => {
  db.signOut();
  setSignedOut();
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
