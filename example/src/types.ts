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
