import type * as rdfjs from "@rdfjs/types";
import type { AnySyncSqliteHandle } from "@/sqlite/any-sync-sqlite-handle.ts";
import { termKey } from "@/sqlite/term/term-key.ts";
import { DEFAULT_SQLITE_MATCH_PAGE_SIZE } from "@/sqlite/quad-store/sqlite-quad-query-builder.ts";
import { fromQuadRecord } from "@/sqlite/rdfjs-store/sqlite-store-codec.ts";

/** queryQuads pages through the quads table for the given match pattern. */
export function queryQuads(
  db: AnySyncSqliteHandle,
  matchPageSize: number | undefined,
  subject?: rdfjs.Term | null,
  predicate?: rdfjs.Term | null,
  object?: rdfjs.Term | null,
  graph?: rdfjs.Term | null,
): rdfjs.Quad[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  const bind = (
    column: string,
    term: rdfjs.Term | null | undefined,
  ): void => {
    if (term != null) {
      where.push(`${column} = ?`);
      args.push(termKey(term));
    }
  };
  bind("skey", subject);
  bind("pkey", predicate);
  bind("okey", object);
  bind("gkey", graph);

  const pageSize = Math.max(
    1,
    Math.floor(
      matchPageSize ?? DEFAULT_SQLITE_MATCH_PAGE_SIZE,
    ),
  );
  const quads: rdfjs.Quad[] = [];
  let anchor: [string, string, string, string] | undefined;

  for (;;) {
    const pageWhere = [...where];
    const pageArgs: Array<string | number> = [...args];
    if (anchor) {
      pageWhere.push("(skey, pkey, okey, gkey) > (?, ?, ?, ?)");
      pageArgs.push(...anchor);
    }
    const sql = "SELECT payload, skey, pkey, okey, gkey FROM quads" +
      (pageWhere.length > 0 ? " WHERE " + pageWhere.join(" AND ") : "") +
      " ORDER BY skey, pkey, okey, gkey LIMIT ?";
    pageArgs.push(pageSize);
    const rows = db.prepare(sql).all(...pageArgs) as Array<
      Record<string, string>
    >;
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      quads.push(fromQuadRecord(JSON.parse(row.payload)));
      anchor = [row.skey, row.pkey, row.okey, row.gkey];
    }
    if (rows.length < pageSize) {
      break;
    }
  }

  return quads;
}
