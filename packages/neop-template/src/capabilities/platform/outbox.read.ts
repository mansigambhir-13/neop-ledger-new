import type { Core } from '../../core.ts';

/** The platform pulls events by cursor (across companies, so the runner role reads it). */
export async function readOutbox(core: Core, after: number, limit: number) {
  const { rows } = await core.runnerPool.query(
    `select id, company_id, event_type, payload, created_at from ${core.key}.outbox where id > $1 order by id limit $2`,
    [after, Math.min(Math.max(limit, 1), 500)],
  );
  return { events: rows, next_cursor: rows.length ? rows[rows.length - 1].id : after };
}
