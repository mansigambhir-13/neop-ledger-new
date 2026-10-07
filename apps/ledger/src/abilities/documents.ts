// Kept source documents (WP §11). A file a person attached is stored by the template (bytes in
// the document store, a row in ledger.documents_files); a bill read from it keeps its sha256.
// This read answers "what is that file, what was recorded from it, and where can a person get
// it" — metadata and a short-lived link Ledger's own files listener serves. Never the bytes.

import type { PoolClient } from '@neop/pgkit';
import { documents, type ReadAbility, type ReadCtx } from '@neop/template';

const S = 'ledger';

/** A kept file of this company (RLS), or null. */
export async function sourceDocumentExists(db: PoolClient, sha256: string): Promise<boolean> {
  return !!(await documents.fileMeta(db, S, sha256));
}

export const documentGet: ReadAbility = {
  kind: 'read',
  async run(a: { sha256: string }, ctx: ReadCtx) {
    const meta = await documents.fileMeta(ctx.db, S, a.sha256);
    const bills = meta
      ? (
          await ctx.db.query<{ number: string; vendor: string; issue_date: string; total_minor: number; currency: string; status: string; entry_id: string | null }>(
            `select d.number, p.name as vendor, d.issue_date, d.total_minor, d.currency, d.status, d.entry_id
               from ${S}.documents d join ${S}.parties p on p.company_id = d.company_id and p.id = d.party_id
              where d.kind = 'bill' and d.source_document = $1 order by d.issue_date, d.number`,
            [a.sha256],
          )
        ).rows
      : [];
    const entryIds = bills.map((b) => b.entry_id).filter((x): x is string => !!x);
    return {
      generatedAt: new Date().toISOString(),
      empty: !meta,
      sources: {
        entries: entryIds.length,
        entry_ids: entryIds.slice(0, 50),
        basis: meta ? `the kept file ${meta.filename} (stored ${meta.stored_at}) and the bills that cite it` : `no file with sha256 ${a.sha256} was attached for this company`,
      },
      document: meta
        ? { sha256: meta.sha256, filename: meta.filename, content_type: meta.content_type, bytes: meta.bytes, stored_at: meta.stored_at, store: meta.store, job_ids: meta.job_ids }
        : null,
      bills: bills.map(({ entry_id: _e, ...b }) => ({ ...b, total_minor: Number(b.total_minor) })),
      download: meta ? documents.documentLink(S, ctx.company_id, meta.sha256) : null,
    };
  },
};
