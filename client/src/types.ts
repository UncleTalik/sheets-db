export type Row = Record<string, unknown>;

export type WherePrimitive = string | number | boolean;

export interface WhereOperators {
  eq?: WherePrimitive;
  ne?: WherePrimitive;
  gt?: WherePrimitive;
  gte?: WherePrimitive;
  lt?: WherePrimitive;
  lte?: WherePrimitive;
  like?: string;
  in?: WherePrimitive[];
  nin?: WherePrimitive[];
}

export type WhereClause = WherePrimitive | WhereOperators;

export type Where = Record<string, WhereClause>;

export type ColumnType =
  | "string"
  | "number"
  | "boolean"
  | "datetime"
  | `enum:${string}`;

export interface ColumnDef {
  column: string;
  type: ColumnType | string;
  required: boolean;
  unique: boolean;
  default: string | null;
}

export type Schema = Record<string, ColumnDef[]>;

export type ErrorCode =
  | "unauthorized"
  | "validation"
  | "not_found"
  | "bad_request"
  | "bad_op"
  | "busy"
  | "misconfigured"
  | "internal";

export class SheetsDBError extends Error {
  readonly code: ErrorCode | string;
  readonly details?: string;
  constructor(code: ErrorCode | string, message: string, details?: string) {
    super(message);
    this.name = "SheetsDBError";
    this.code = code;
    this.details = details;
  }
}

export interface User {
  email: string;
  name: string;
}

export type Op = "schema" | "select" | "insert" | "update" | "delete" | "provision";

export interface ColumnSpec {
  column: string;
  type: ColumnType | string;
  required?: boolean;
  unique?: boolean;
  default?: string | null;
}

export interface ProvisionSpec {
  tables?: Record<string, ColumnSpec[]>;
  allowlist?: string[];
}

export interface ProvisionResult {
  tablesCreated: string[];
  tablesSkipped: string[];
  columnsAdded: Record<string, string[]>;
  allowlistAdded: string[];
}

export interface RpcRequest {
  idToken: string;
  op: Op;
  table?: string;
  where?: Where;
  row?: Row;
  id?: string;
  spec?: ProvisionSpec;
}

export type RpcResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; details?: string };

export interface ClientConfig {
  webAppUrl: string;
  googleClientId: string;
}

export interface TableQuery<T = Row> {
  /**
   * Add an AND-merged filter clause. Same-field clauses replace each other —
   * combine multiple operators on one field in a single call:
   * `.where({ amount: { gt: 5, lte: 10 } })`.
   *
   * Magic columns: any column whose name starts with `_` is server-managed.
   * Filters supplied for them are silently overridden — e.g. on a row-scoped
   * table (one with a `_userIdentifier` column) the server clamps every
   * `select` to the caller's own rows regardless of what you pass here.
   */
  where(filter: Where): TableQuery<T>;
  select(): Promise<T[]>;
  selectOne(): Promise<T | null>;
  /**
   * Insert a row. Magic columns (names starting with `_`) are server-managed;
   * any value supplied for them is ignored. On a row-scoped table the server
   * stamps `_userIdentifier` with the caller's email automatically.
   */
  insert(row: Partial<T>): Promise<T>;
  /**
   * Update a row. Magic columns (names starting with `_`) cannot be modified
   * via update — values supplied for them in the patch are stripped. On a
   * row-scoped table, attempting to update a row owned by a different user
   * returns `not_found`.
   */
  update(id: string, patch: Partial<T>): Promise<T>;
  delete(id: string): Promise<{ id: string }>;
}

export interface SheetsDB {
  signIn(): Promise<User>;
  signOut(): void;
  currentUser(): User | null;
  table<T = Row>(name: string): TableQuery<T>;
  schema(): Promise<Schema>;
  provision(spec: ProvisionSpec): Promise<ProvisionResult>;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
          }) => void;
          prompt: (
            listener?: (notification: {
              isNotDisplayed: () => boolean;
              isSkippedMoment: () => boolean;
              getNotDisplayedReason: () => string;
              getSkippedReason: () => string;
            }) => void,
          ) => void;
          disableAutoSelect: () => void;
        };
      };
    };
  }
}
