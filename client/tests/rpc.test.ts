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

    it.each([
      { label: "single-element array", value: ["_meta"] },
      { label: "object with custom toString", value: { toString: (): string => "_evil" } },
    ])(
      "rejects $label that coerces to a leading-underscore string",
      async ({ value }) => {
        // A caller bypassing the TS type would otherwise be resolved by
        // Google Sheets via String() coercion (e.g. ["_meta"] → "_meta").
        const fetchMock = vi.fn();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        const rpc = createRpc(WEB_APP_URL, () => TOKEN);

        await expect(
          rpc.call({ op: "select", table: value as unknown as string }),
        ).rejects.toMatchObject({
          name: "SheetsDBError",
          code: "unauthorized",
        });
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      { label: "number", value: 42 },
      { label: "boolean", value: true },
      { label: "null", value: null },
      { label: "object without leading-underscore toString", value: {} },
    ])(
      "lets $label through to the server (server is the boundary)",
      async ({ value }) => {
        // Inputs whose String() coercion does NOT start with "_" pass the
        // client guard. The server's requireString then rejects them with
        // bad_request — no system sheet is ever resolved.
        const fetchMock = mockFetchJson({ ok: false, error: "bad_request" });
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        const rpc = createRpc(WEB_APP_URL, () => TOKEN);

        await expect(
          rpc.call({ op: "select", table: value as unknown as string }),
        ).rejects.toMatchObject({ code: "bad_request" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe("sharing wire format", () => {
    it("share carries email + perm at top level", async () => {
      const fetchMock = mockFetchJson({ ok: true, data: { id: "n_1" } });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const rpc = createRpc(WEB_APP_URL, () => TOKEN);

      await rpc.call({
        op: "share",
        table: "notes",
        id: "n_1",
        email: "b@x.io",
        perm: "WRITE",
      });
      const [, init] = fetchMock.mock.calls[0]!;
      expect(JSON.parse(init!.body as string)).toEqual({
        idToken: TOKEN,
        op: "share",
        table: "notes",
        id: "n_1",
        email: "b@x.io",
        perm: "WRITE",
      });
    });

    it("unshare carries email at top level", async () => {
      const fetchMock = mockFetchJson({ ok: true, data: { id: "n_1" } });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const rpc = createRpc(WEB_APP_URL, () => TOKEN);

      await rpc.call({
        op: "unshare",
        table: "notes",
        id: "n_1",
        email: "b@x.io",
      });
      const [, init] = fetchMock.mock.calls[0]!;
      expect(JSON.parse(init!.body as string)).toEqual({
        idToken: TOKEN,
        op: "unshare",
        table: "notes",
        id: "n_1",
        email: "b@x.io",
      });
    });

    it("insert with shareWith forwards the array verbatim", async () => {
      const fetchMock = mockFetchJson({ ok: true, data: { id: "n_1" } });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const rpc = createRpc(WEB_APP_URL, () => TOKEN);

      await rpc.call({
        op: "insert",
        table: "notes",
        row: { title: "x" },
        shareWith: [{ email: "b@x.io", perm: "READ" }],
      });
      const [, init] = fetchMock.mock.calls[0]!;
      expect(JSON.parse(init!.body as string)).toEqual({
        idToken: TOKEN,
        op: "insert",
        table: "notes",
        row: { title: "x" },
        shareWith: [{ email: "b@x.io", perm: "READ" }],
      });
    });

    it("update with shareWith + unshareWith forwards both", async () => {
      const fetchMock = mockFetchJson({ ok: true, data: { id: "n_1" } });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const rpc = createRpc(WEB_APP_URL, () => TOKEN);

      await rpc.call({
        op: "update",
        table: "notes",
        id: "n_1",
        row: { title: "y" },
        shareWith: [{ email: "c@x.io", perm: "WRITE_DELETE" }],
        unshareWith: ["b@x.io"],
      });
      const [, init] = fetchMock.mock.calls[0]!;
      expect(JSON.parse(init!.body as string)).toEqual({
        idToken: TOKEN,
        op: "update",
        table: "notes",
        id: "n_1",
        row: { title: "y" },
        shareWith: [{ email: "c@x.io", perm: "WRITE_DELETE" }],
        unshareWith: ["b@x.io"],
      });
    });

    it("share / unshare against a system table is rejected client-side", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const rpc = createRpc(WEB_APP_URL, () => TOKEN);

      await expect(
        rpc.call({ op: "share", table: "_meta", id: "x", email: "y@z", perm: "READ" }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      await expect(
        rpc.call({ op: "unshare", table: "_allowlist", id: "x", email: "y@z" }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(fetchMock).not.toHaveBeenCalled();
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
