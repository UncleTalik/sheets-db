import { describe, expect, it, vi } from "vitest";
import { createTableQuery } from "../src/query.js";
import type { RpcClient } from "../src/rpc.js";

interface Expense {
  id: string;
  amount: number;
  category: string;
  note?: string;
}

function mockRpc() {
  const call = vi.fn(async (_opts: unknown) => [] as unknown);
  const rpc: RpcClient = { call: call as RpcClient["call"] };
  return { rpc, call };
}

describe("TableQuery", () => {
  it("select with no where sends empty filter", async () => {
    const { rpc, call } = mockRpc();
    call.mockResolvedValueOnce([]);
    await createTableQuery<Expense>(rpc, "expenses").select();
    expect(call).toHaveBeenCalledWith({ op: "select", table: "expenses", where: {} });
  });

  it("where() produces a new instance without mutating the base", async () => {
    const { rpc, call } = mockRpc();
    const base = createTableQuery<Expense>(rpc, "expenses");
    const filtered = base.where({ category: "groceries" });
    expect(filtered).not.toBe(base);

    call.mockResolvedValueOnce([]);
    await base.select();
    expect(call).toHaveBeenLastCalledWith({ op: "select", table: "expenses", where: {} });

    call.mockResolvedValueOnce([]);
    await filtered.select();
    expect(call).toHaveBeenLastCalledWith({
      op: "select",
      table: "expenses",
      where: { category: "groceries" },
    });
  });

  it("chained where() merges filters", async () => {
    const { rpc, call } = mockRpc();
    call.mockResolvedValueOnce([]);
    await createTableQuery<Expense>(rpc, "expenses")
      .where({ category: "groceries" })
      .where({ amount: 10 })
      .select();
    expect(call).toHaveBeenCalledWith({
      op: "select",
      table: "expenses",
      where: { category: "groceries", amount: 10 },
    });
  });

  it("later where() overrides the same key", async () => {
    const { rpc, call } = mockRpc();
    call.mockResolvedValueOnce([]);
    await createTableQuery<Expense>(rpc, "expenses")
      .where({ category: "groceries" })
      .where({ category: "gas" })
      .select();
    expect(call).toHaveBeenCalledWith({
      op: "select",
      table: "expenses",
      where: { category: "gas" },
    });
  });

  it("selectOne returns first row or null", async () => {
    const { rpc, call } = mockRpc();
    const row = { id: "exp_1", amount: 5, category: "x" };
    call.mockResolvedValueOnce([row]);
    expect(await createTableQuery<Expense>(rpc, "expenses").selectOne()).toEqual(row);

    call.mockResolvedValueOnce([]);
    expect(await createTableQuery<Expense>(rpc, "expenses").selectOne()).toBeNull();
  });

  it("insert sends op=insert with row", async () => {
    const { rpc, call } = mockRpc();
    const inserted = { id: "exp_1", amount: 12.5, category: "groceries" };
    call.mockResolvedValueOnce(inserted);
    const result = await createTableQuery<Expense>(rpc, "expenses").insert({
      amount: 12.5,
      category: "groceries",
    });
    expect(call).toHaveBeenCalledWith({
      op: "insert",
      table: "expenses",
      row: { amount: 12.5, category: "groceries" },
    });
    expect(result).toEqual(inserted);
  });

  it("update sends op=update with id + patch", async () => {
    const { rpc, call } = mockRpc();
    const updated = { id: "exp_1", amount: 20, category: "groceries" };
    call.mockResolvedValueOnce(updated);
    await createTableQuery<Expense>(rpc, "expenses").update("exp_1", { amount: 20 });
    expect(call).toHaveBeenCalledWith({
      op: "update",
      table: "expenses",
      id: "exp_1",
      row: { amount: 20 },
    });
  });

  it("delete sends op=delete with id", async () => {
    const { rpc, call } = mockRpc();
    call.mockResolvedValueOnce({ id: "exp_1" });
    const result = await createTableQuery<Expense>(rpc, "expenses").delete("exp_1");
    expect(call).toHaveBeenCalledWith({ op: "delete", table: "expenses", id: "exp_1" });
    expect(result).toEqual({ id: "exp_1" });
  });

  it("base query is reusable after .where() was called on it", async () => {
    const { rpc, call } = mockRpc();
    const base = createTableQuery<Expense>(rpc, "expenses");
    base.where({ category: "groceries" }); // throwaway derived query

    call.mockResolvedValueOnce([]);
    await base.select();
    expect(call).toHaveBeenLastCalledWith({ op: "select", table: "expenses", where: {} });
  });

  it("operator clause passes through verbatim", async () => {
    const { rpc, call } = mockRpc();
    call.mockResolvedValueOnce([]);
    await createTableQuery<Expense>(rpc, "expenses")
      .where({ amount: { gte: 5, lt: 10 } })
      .select();
    expect(call).toHaveBeenCalledWith({
      op: "select",
      table: "expenses",
      where: { amount: { gte: 5, lt: 10 } },
    });
  });

  it("`in` array clause passes through verbatim", async () => {
    const { rpc, call } = mockRpc();
    call.mockResolvedValueOnce([]);
    await createTableQuery<Expense>(rpc, "expenses")
      .where({ category: { in: ["groceries", "gas"] } })
      .select();
    expect(call).toHaveBeenCalledWith({
      op: "select",
      table: "expenses",
      where: { category: { in: ["groceries", "gas"] } },
    });
  });

  it("`like` clause passes through verbatim", async () => {
    const { rpc, call } = mockRpc();
    call.mockResolvedValueOnce([]);
    await createTableQuery<Expense>(rpc, "expenses")
      .where({ note: { like: "%test%" } })
      .select();
    expect(call).toHaveBeenCalledWith({
      op: "select",
      table: "expenses",
      where: { note: { like: "%test%" } },
    });
  });

  it("primitive shorthand and operator clause coexist on different fields", async () => {
    const { rpc, call } = mockRpc();
    call.mockResolvedValueOnce([]);
    await createTableQuery<Expense>(rpc, "expenses")
      .where({ category: "groceries", amount: { gt: 1 } })
      .select();
    expect(call).toHaveBeenCalledWith({
      op: "select",
      table: "expenses",
      where: { category: "groceries", amount: { gt: 1 } },
    });
  });

  it("later where() replaces an operator clause on the same field", async () => {
    const { rpc, call } = mockRpc();
    call.mockResolvedValueOnce([]);
    await createTableQuery<Expense>(rpc, "expenses")
      .where({ amount: { gt: 5 } })
      .where({ amount: { lt: 10 } })
      .select();
    expect(call).toHaveBeenCalledWith({
      op: "select",
      table: "expenses",
      where: { amount: { lt: 10 } },
    });
  });
});
