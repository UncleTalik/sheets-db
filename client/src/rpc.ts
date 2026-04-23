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
