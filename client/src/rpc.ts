import {
  SheetsDBError,
  type Op,
  type ProvisionSpec,
  type RpcRequest,
  type RpcResponse,
  type Row,
  type Where,
} from "./types.js";

export interface RpcOptions {
  op: Op;
  table?: string;
  where?: Where;
  row?: Row;
  id?: string;
  spec?: ProvisionSpec;
}

export interface RpcClient {
  call<T>(opts: RpcOptions): Promise<T>;
}

export function createRpc(
  webAppUrl: string,
  getIdToken: () => string | null,
): RpcClient {
  return {
    async call<T>(opts: RpcOptions): Promise<T> {
      const idToken = getIdToken();
      if (!idToken) {
        throw new SheetsDBError(
          "unauthorized",
          "not signed in; call signIn() before making requests",
        );
      }

      // System sheets (`_meta`, `_allowlist`, any future `_*`) are managed
      // by the owner via the spreadsheet UI; the backend rejects them too.
      // Short-circuiting here saves a round-trip and gives a clearer stack.
      // Coerce via String() so a caller passing a non-string (e.g. an
      // array, bypassing the TS type) can't slip past — Sheets would
      // resolve `["_meta"]` to "_meta" server-side otherwise.
      if (opts.table !== undefined && String(opts.table).startsWith("_")) {
        throw new SheetsDBError(
          "unauthorized",
          `table ${String(opts.table)} is reserved (system table)`,
        );
      }

      const body: RpcRequest = { idToken, ...opts };

      let res: Response;
      try {
        res = await fetch(webAppUrl, {
          method: "POST",
          // Apps Script responds with a 302 to a googleusercontent.com URL.
          // "follow" is the default but set explicitly for clarity.
          redirect: "follow",
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new SheetsDBError(
          "internal",
          "network error calling backend",
          err instanceof Error ? err.message : String(err),
        );
      }

      if (!res.ok) {
        throw new SheetsDBError(
          "internal",
          `backend responded with HTTP ${res.status}`,
        );
      }

      let json: RpcResponse<T>;
      try {
        json = (await res.json()) as RpcResponse<T>;
      } catch (err) {
        throw new SheetsDBError(
          "internal",
          "backend returned non-JSON response",
          err instanceof Error ? err.message : String(err),
        );
      }

      if (!json.ok) {
        throw new SheetsDBError(json.error, json.error, json.details);
      }
      return json.data;
    },
  };
}
