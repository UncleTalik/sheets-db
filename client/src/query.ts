import type { RpcClient } from "./rpc.js";
import type {
  InsertOptions,
  Permission,
  Row,
  TableQuery,
  UpdateOptions,
  Where,
} from "./types.js";

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

    async insert(row: Partial<T>, opts?: InsertOptions): Promise<T> {
      return rpc.call<T>({
        op: "insert",
        table,
        row: row as unknown as Row,
        ...(opts?.shareWith ? { shareWith: opts.shareWith } : {}),
      });
    },

    async update(id: string, patch: Partial<T>, opts?: UpdateOptions): Promise<T> {
      return rpc.call<T>({
        op: "update",
        table,
        id,
        row: patch as unknown as Row,
        ...(opts?.shareWith ? { shareWith: opts.shareWith } : {}),
        ...(opts?.unshareWith ? { unshareWith: opts.unshareWith } : {}),
      });
    },

    async delete(id: string): Promise<{ id: string }> {
      return rpc.call<{ id: string }>({ op: "delete", table, id });
    },

    async share(id: string, email: string, perm: Permission): Promise<T> {
      return rpc.call<T>({ op: "share", table, id, email, perm });
    },

    async unshare(id: string, email: string): Promise<T> {
      return rpc.call<T>({ op: "unshare", table, id, email });
    },
  };
}
