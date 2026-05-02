# Schema reference

SheetsDB schemas live in the `_meta` sheet. Each row defines one column of one
table. The backend reads `_meta` at the start of every request (cached for the
lifetime of that request only).

> You usually don't edit `_meta` by hand — call
> [`db.provision(...)`](../client/README.md#provision--declarative-schema-setup)
> from your app and the backend writes these rows for you. This doc is the
> reference for the values `provision` accepts and what they mean.

## `_meta` columns

| column     | meaning |
|------------|---------|
| `table`    | Table name. Must match the sheet name exactly. |
| `column`   | Column name. Must match the header cell in that sheet. |
| `type`     | See [types](#types). |
| `required` | `TRUE` = reject inserts/updates that leave this column empty after defaults. |
| `unique`   | `TRUE` = reject writes that duplicate an existing value in this column. |
| `default`  | See [defaults](#defaults). Leave blank for no default. |

Header row 1 must contain exactly these six column names, in any order.

## Types

| type           | validation |
|----------------|------------|
| `string`       | Coerced via `String(v)`. Always accepted. |
| `number`       | Coerced via `Number(v)`; rejected if `NaN`. |
| `boolean`      | Accepts real booleans, `"true"`/`"false"`, `"1"`/`"0"`, empty string (→ false). |
| `datetime`     | Accepts anything `new Date(v)` can parse; stored as ISO 8601 string. |
| `enum:a\|b\|c` | Value must be one of the listed options. Separator is `\|`. |

Unknown types fall through to `string`.

## Defaults

Applied only when the incoming value is `undefined`, `null`, or `""`:

| default | behavior |
|---------|----------|
| `auto`  | On the `id` column only: generates a short ID like `exp_k3j8f2a1bc`. |
| `now`   | Current ISO 8601 timestamp. Useful on `createdAt`. |
| *literal string* | Used as-is (coerced to the column's type). |
| *(blank)* | No default. Required columns must be supplied by the caller. |

## Adding a column

1. Add a row to `_meta` describing the new column.
2. Add a header cell to the data sheet. **Column order between the sheet
   header and `_meta` must agree** — the header row is the source of truth
   for cell positions, and the schema is the source of truth for types.
3. Existing rows get an empty cell for the new column. If the new column is
   `required` without a `default`, every row you read back will fail
   validation on update — so either add a default, leave it non-required, or
   backfill the sheet manually.

## Adding a table

1. Create a new sheet whose name is the table name.
2. Add the header row (column names in the order you want).
3. Add rows to `_meta` for each column.

Make sure every table has an `id` column of type `string` with `unique: TRUE`
and `default: auto`. `update` and `delete` rely on `id`.

> **Reserved names.** Sheet names starting with `_` are reserved for
> SheetsDB system tables (`_meta`, `_allowlist`, and any future ones).
> The RPC API rejects `select`/`insert`/`update`/`delete` against `_*`
> tables with `unauthorized`, and `provision` rejects `_*` keys in
> `spec.tables` with `validation`. Don't name user tables with a
> leading underscore.

## Invariants the backend assumes

- Column order in the data sheet header matches the order of columns you want
  written. The backend uses the header to map column names → sheet positions.
- `id` is always the primary key. `update`/`delete` look up rows by `id`.
- If a column is named `updatedAt`, `update` will refresh it automatically.
