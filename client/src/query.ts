import type { RpcClient } from "./rpc.js";
import type { Row, TableQuery, Where } from "./types.js";

export function createTableQuery<T = Row>(
  rpc: RpcClient,
  table: string,
  filter: Where = {},
): TableQuery<T> {
  return {
    where(next: Where): TableQuery<T> {
      // Immutable: return a new query object with merged filters so callers
      // can safely reuse a base `db.table("x")` handle.
      return createTableQuery<T>(rpc, table, { ...filter, ...next });
    },

    async select(): Promise<T[]> {
      return rpc.call<T[]>({ op: "select", table, where: filter });
    },

    async selectOne(): Promise<T | null> {
      const rows = await rpc.call<T[]>({ op: "select", table, where: filter });
      return rows[0] ?? null;
    },

    async insert(row: Partial<T>): Promise<T> {
      return rpc.call<T>({ op: "insert", table, row: row as unknown as Row });
    },

    async update(id: string, patch: Partial<T>): Promise<T> {
      return rpc.call<T>({ op: "update", table, id, row: patch as unknown as Row });
    },

    async delete(id: string): Promise<{ id: string }> {
      return rpc.call<{ id: string }>({ op: "delete", table, id });
    },
  };
}
