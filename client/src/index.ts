import { createAuth } from "./auth.js";
import { createRpc } from "./rpc.js";
import { createTableQuery } from "./query.js";
import type {
  ClientConfig,
  ProvisionResult,
  ProvisionSpec,
  Row,
  Schema,
  SheetsDB,
  TableQuery,
} from "./types.js";

export { SheetsDBError } from "./types.js";
export type {
  ClientConfig,
  ColumnDef,
  ColumnSpec,
  ColumnType,
  ErrorCode,
  Op,
  ProvisionResult,
  ProvisionSpec,
  Row,
  RpcRequest,
  RpcResponse,
  Schema,
  SheetsDB,
  TableQuery,
  User,
  Where,
  WhereClause,
  WhereOperators,
  WherePrimitive,
} from "./types.js";

export function createClient(config: ClientConfig): SheetsDB {
  const auth = createAuth(config.googleClientId);
  const rpc = createRpc(config.webAppUrl, () => auth.getIdToken());

  return {
    signIn: () => auth.signIn(),
    signOut: () => auth.signOut(),
    currentUser: () => auth.currentUser(),
    table<T = Row>(name: string): TableQuery<T> {
      return createTableQuery<T>(rpc, name);
    },
    async schema(): Promise<Schema> {
      return rpc.call<Schema>({ op: "schema" });
    },
    async provision(spec: ProvisionSpec): Promise<ProvisionResult> {
      return rpc.call<ProvisionResult>({ op: "provision", spec });
    },
  };
}
