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

export type Op =
  | "schema"
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "provision"
  | "share"
  | "unshare";

/**
 * Permission tiers a row owner can grant via the `_sharedWith` magic column.
 * - `READ`         — visible in `select`.
 * - `WRITE`        — `READ` + update of data fields (cannot edit `_sharedWith` or delete).
 * - `WRITE_DELETE` — `WRITE` + delete.
 * The owner has all rights implicitly + share-list management. Only the
 * owner may modify the share list; WRITE / WRITE_DELETE collaborators
 * supplying `shareWith` / `unshareWith` get an `unauthorized` error.
 */
export type Permission = "READ" | "WRITE" | "WRITE_DELETE";

export interface ShareEntry {
  email: string;
  perm: Permission;
}

export interface InsertOptions {
  /** Inline share list applied at row creation. Caller becomes the owner,
   *  so authority is implicit — no separate share() round-trip needed. */
  shareWith?: ShareEntry[];
}

export interface UpdateOptions {
  /** Owner-only. Each entry upserts (overwrites any existing entry for the
   *  same email). Non-owner callers passing this get `unauthorized`. */
  shareWith?: ShareEntry[];
  /** Owner-only. Idempotent removal — unknown emails are no-ops. */
  unshareWith?: string[];
}

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
  // Sharing wire fields:
  email?: string;
  perm?: Permission;
  shareWith?: ShareEntry[];
  unshareWith?: string[];
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
   * On a row-scoped table (one with a `_userIdentifier` column) the server
   * gates visibility to rows you own or have been shared, and silently
   * drops any client predicate referencing `_sharedWith` (anti-enumeration).
   * Filters on `_userIdentifier` are honored but cannot expand visibility
   * beyond your accessible rows.
   */
  where(filter: Where): TableQuery<T>;
  select(): Promise<T[]>;
  selectOne(): Promise<T | null>;
  /**
   * Insert a row. Magic columns (names starting with `_`) are server-managed;
   * any value supplied for them in `row` is ignored. On a row-scoped table
   * the server stamps `_userIdentifier` with the caller's email automatically.
   *
   * Pass `opts.shareWith` to atomically grant access to other users in the
   * same op — the caller becomes the owner, so this is just a round-trip
   * saver over a follow-up `.share()` call.
   */
  insert(row: Partial<T>, opts?: InsertOptions): Promise<T>;
  /**
   * Update a row. Magic columns (names starting with `_`) cannot be modified
   * via the patch — values supplied for them are stripped. On a row-scoped
   * table, attempting to update a row owned by a different user (and where
   * you have no WRITE / WRITE_DELETE share) returns `not_found`.
   *
   * Owner-only: pass `opts.shareWith` / `opts.unshareWith` to amend the
   * share list in the same op. WRITE / WRITE_DELETE collaborators passing
   * either get `unauthorized`.
   */
  update(id: string, patch: Partial<T>, opts?: UpdateOptions): Promise<T>;
  delete(id: string): Promise<{ id: string }>;
  /**
   * Owner-only. Grant `email` permission `perm` on row `id`. Upsert
   * semantics — calling with the same email twice replaces the existing
   * perm. Sharing with a non-allowlisted email is allowed but dormant
   * (the recipient can't authenticate until they're allowlisted).
   * Returns the updated row.
   */
  share(id: string, email: string, perm: Permission): Promise<T>;
  /**
   * Owner-only. Revoke any share for `email` on row `id`. Idempotent —
   * unknown emails are a no-op. Returns the updated row.
   */
  unshare(id: string, email: string): Promise<T>;
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
