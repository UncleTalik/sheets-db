import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRpc } from "../src/rpc.js";
import { SheetsDBError } from "../src/types.js";

const WEB_APP_URL = "https://script.google.com/macros/s/FAKE/exec";
const TOKEN = "fake.id.token";

function mockFetchJson(body: unknown, init: Partial<Response> = {}) {
  const res = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
  return vi.fn(async (_url: string, _init?: RequestInit) => res);
}

describe("rpc", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends POST with JSON body containing idToken + op, follows redirects", async () => {
    const fetchMock = mockFetchJson({ ok: true, data: [] });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const rpc = createRpc(WEB_APP_URL, () => TOKEN);
    await rpc.call({ op: "select", table: "expenses", where: { category: "g" } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(WEB_APP_URL);
    expect(init!.method).toBe("POST");
    expect(init!.redirect).toBe("follow");
    expect(JSON.parse(init!.body as string)).toEqual({
      idToken: TOKEN,
      op: "select",
      table: "expenses",
      where: { category: "g" },
    });
  });

  it("returns data on ok:true response", async () => {
    globalThis.fetch = mockFetchJson({ ok: true, data: [{ id: "x" }] }) as unknown as typeof fetch;
    const rpc = createRpc(WEB_APP_URL, () => TOKEN);
    const result = await rpc.call<Array<{ id: string }>>({ op: "select", table: "x" });
    expect(result).toEqual([{ id: "x" }]);
  });

  it("throws SheetsDBError with the error code from ok:false response", async () => {
    globalThis.fetch = mockFetchJson({
      ok: false,
      error: "validation",
      details: "amount must be a number",
    }) as unknown as typeof fetch;
    const rpc = createRpc(WEB_APP_URL, () => TOKEN);
    await expect(rpc.call({ op: "insert", table: "x", row: {} })).rejects.toMatchObject({
      name: "SheetsDBError",
      code: "validation",
      details: "amount must be a number",
    });
  });

  it("throws unauthorized when no id token is available", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const rpc = createRpc(WEB_APP_URL, () => null);
    await expect(rpc.call({ op: "select", table: "x" })).rejects.toBeInstanceOf(SheetsDBError);
    await expect(rpc.call({ op: "select", table: "x" })).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("throws internal on network error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const rpc = createRpc(WEB_APP_URL, () => TOKEN);
    await expect(rpc.call({ op: "select", table: "x" })).rejects.toMatchObject({
      code: "internal",
    });
  });

  it("throws internal on non-2xx HTTP status", async () => {
    globalThis.fetch = mockFetchJson({}, { ok: false, status: 500 }) as unknown as typeof fetch;
    const rpc = createRpc(WEB_APP_URL, () => TOKEN);
    await expect(rpc.call({ op: "select", table: "x" })).rejects.toMatchObject({
      code: "internal",
    });
  });

  describe("system table guard", () => {
    it("rejects select against _meta without calling fetch", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const rpc = createRpc(WEB_APP_URL, () => TOKEN);

      await expect(rpc.call({ op: "select", table: "_meta" })).rejects.toMatchObject({
        name: "SheetsDBError",
        code: "unauthorized",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects insert against _allowlist without calling fetch", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const rpc = createRpc(WEB_APP_URL, () => TOKEN);

      await expect(
        rpc.call({ op: "insert", table: "_allowlist", row: { email: "x@y.z" } }),
      ).rejects.toMatchObject({
        name: "SheetsDBError",
        code: "unauthorized",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still calls fetch for normal user tables", async () => {
      const fetchMock = mockFetchJson({ ok: true, data: [] });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const rpc = createRpc(WEB_APP_URL, () => TOKEN);

      await rpc.call({ op: "select", table: "expenses" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("provision sends op=provision with spec at top level (not in row)", async () => {
    const result = {
      tablesCreated: ["expenses"],
      tablesSkipped: [],
      columnsAdded: {},
      allowlistAdded: ["a@example.com"],
    };
    const fetchMock = mockFetchJson({ ok: true, data: result });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const rpc = createRpc(WEB_APP_URL, () => TOKEN);
    const spec = {
      tables: {
        expenses: [
          { column: "id", type: "string", required: true, unique: true, default: "auto" },
          { column: "amount", type: "number", required: true },
        ],
      },
      allowlist: ["a@example.com"],
    };
    const out = await rpc.call({ op: "provision", spec });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({
      idToken: TOKEN,
      op: "provision",
      spec,
    });
    expect(out).toEqual(result);
  });
});
