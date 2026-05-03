import type { ColumnSpec } from "@UncleTalik/sheetsdb-client";

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

// Notes are row-scoped: the `_userIdentifier` magic column makes each row
// visible and mutable only by the user who created it. The server stamps
// the column on insert; clients never set it.
export interface Note {
  id: string;
  createdAt: string;
  title: string;
  body?: string;
  _userIdentifier: string;
}

export const NOTES_SCHEMA: ColumnSpec[] = [
  { column: "id",              type: "string",   required: true, unique: true, default: "auto" },
  { column: "createdAt",       type: "datetime", required: true, default: "now" },
  { column: "title",           type: "string",   required: true },
  { column: "body",            type: "string" },
  { column: "_userIdentifier", type: "string",   required: true },
];
