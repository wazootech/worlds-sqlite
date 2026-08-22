/**
 * SqlStatement is a single parameterized SQL statement using `?` placeholders.
 * It is the shared plan shape for every driver-free sql-core emitter: backend
 * packages execute plans through their own connection drivers (sync
 * node:sqlite, async LibSQL), never inside this module.
 */
export type SqlBindValue = string | number | bigint | Uint8Array | null;

export interface SqlStatement {
  /** sql is the statement text, using `?` placeholders. */
  sql: string;

  /** args are the positional bind values for the statement's placeholders. */
  args?: SqlBindValue[];
}
