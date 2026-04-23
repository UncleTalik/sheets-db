// Must match the `expenses` table in _meta.
export interface Expense {
  id: string;
  createdAt: string;
  amount: number;
  category: string;
  note?: string;
}
