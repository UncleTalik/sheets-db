import type { ColumnSpec, Permission } from "@UncleTalik/sheetsdb-client";

export type { Permission } from "@UncleTalik/sheetsdb-client";

// Keep this in sync with EXPENSES_SCHEMA below — the types the app relies on
// at compile time should mirror the runtime shape it asks the backend to create.
export interface Expense {
  id: string;
  createdAt: string;
  amount: number;
  category: string;
  note?: string;
}

export const EXPENSES_SCHEMA: ColumnSpec[] = [
  { column: "id",        type: "string",   required: true, unique: true, default: "auto" },
  { column: "createdAt", type: "datetime", required: true, default: "now" },
  { column: "amount",    type: "number",   required: true },
  { column: "category",  type: "string",   required: true },
  { column: "note",      type: "string" },
];

// Notes are row-scoped (`_userIdentifier`) AND shareable (`_sharedWith`):
// each row is visible to its owner, plus any user the owner has shared it
// with. The server stamps `_userIdentifier` on insert and manages
// `_sharedWith` via the `share`/`unshare` ops or inline opts on
// `insert`/`update`. `_sharedWith` is returned as a JSON-encoded string.
export interface Note {
  id: string;
  createdAt: string;
  title: string;
  body?: string;
  _userIdentifier: string;
  _sharedWith: string;
}

// Shape clients construct. The server-managed columns (`id`, `createdAt`,
// `_userIdentifier`, `_sharedWith`) are filled in by defaults / magic-column
// stamping / share-list mutations.
export type NoteInput = Pick<Note, "title"> & Partial<Pick<Note, "body">>;

// Parsed shape of `_sharedWith`. Mirrors the wire-level `ShareEntry`.
export interface ParsedShare {
  email: string;
  perm: Permission;
}

export const NOTES_SCHEMA: ColumnSpec[] = [
  { column: "id",              type: "string",   required: true, unique: true, default: "auto" },
  { column: "createdAt",       type: "datetime", required: true, default: "now" },
  { column: "title",           type: "string",   required: true },
  { column: "body",            type: "string" },
  { column: "_userIdentifier", type: "string",   required: true },
  { column: "_sharedWith",     type: "string" },
];
