// PRESENCE · who is who in Matrix, from this app's own schema only (v3 §9 "one name per app, per company";
// §13 `identity.ts`). Never the platform API, never schema neos:
//   · <schema>.installs.matrix_user — the app's own name at the company (@neop_<app>_<company> on the appservice
//     road, an ordinary account such as @ledger:hs on the client road); room_ids — its rooms there;
//     agent_senders / agent_acts_for — the non-people allowed to write (the reasoning agent, bridges, other NEOPs)
//     and the person each relays for.
//   · <schema>.people — every person of the company linked to a Matrix id (user id, name, role) and whether they
//     may DM the app (chat_person).
// The platform writes these through as neos_desk (Platform.syncChat / setChatIdentity; template t012); this
// file only reads them, over the runner's pool.

import type { Pool } from '@neop/pgkit';
import type { SenderClass } from '@neop/contracts';

export interface InstallIdentity {
  company_id: string;
  status: string;
  company_name: string | null;
  company_slug: string | null;
  matrix_user: string | null;
  room_ids: string[];
  agent_senders: string[];
  agent_acts_for: Record<string, string>;
  /** v3 S6 (t015): the company's bus room (#neop-bus-<co>) and the other apps on it (Matrix id → app key). */
  bus_room_id: string | null;
  bus_peers: Record<string, string>;
}

export interface Person {
  /** The platform user id (the book records `user:<id>`). */
  id: string;
  company_id: string;
  name: string;
  role: string;
  matrix_id: string | null; // null: a person a bridge relays for, with no Matrix id of their own (t017)
  /** On the app's chat allowlist as a person (may DM it on the client road). */
  chat_person: boolean;
}

/** Who is writing, by class (v3 §8 TYPED_SENDERS): a person, or a non-person with the person it relays for. */
export type Who = { cls: 'person'; person: Person } | { cls: Exclude<SenderClass, 'person'>; actsFor: string | null; /** v3 S6: a peer on the bus room — its app key. */ app?: string };

/** A non-person on the allowlist is a NEOP when it speaks from the apps' exclusive namespace, else an agent/bridge. */
export const classOfNonPerson = (mxid: string): Exclude<SenderClass, 'person'> => (/^@neop_/.test(mxid) ? 'neop' : 'agent');

/** The appservice name of an app at a company: @neop_<app>_<company slug>:<server>. */
export const neopUser = (app: string, slug: string, server: string): string => `@neop_${app}_${slug}:${server}`;

export class Identity {
  readonly pool: Pool;
  readonly s: string;
  constructor(pool: Pool, schema: string) {
    this.pool = pool;
    this.s = schema;
  }

  private cols = 'company_id, status, company_name, company_slug, matrix_user, room_ids, agent_senders, agent_acts_for, bus_room_id, bus_peers';

  async install(companyId: string): Promise<InstallIdentity | null> {
    return (await this.pool.query<InstallIdentity>(`select ${this.cols} from ${this.s}.installs where company_id = $1`, [companyId])).rows[0] ?? null;
  }

  /** The active installs that speak as this Matrix name (one, normally). */
  async installsOf(matrixUser: string): Promise<InstallIdentity[]> {
    return (await this.pool.query<InstallIdentity>(`select ${this.cols} from ${this.s}.installs where matrix_user = $1 and status = 'active'`, [matrixUser])).rows;
  }

  /** The active install whose rooms (or bus room, v3 S6) include this one (the appservice road); null: not our room. */
  async installOfRoom(roomId: string): Promise<InstallIdentity | null> {
    const rows = (await this.pool.query<InstallIdentity>(`select ${this.cols} from ${this.s}.installs where ($1 = any(room_ids) or bus_room_id = $1) and status = 'active' and matrix_user is not null`, [roomId])).rows;
    return rows.length === 1 ? rows[0]! : null; // a room bound to two companies is nobody's
  }

  /** Every active install with a Matrix name (the appservice road serves them all). */
  async named(): Promise<InstallIdentity[]> {
    return (await this.pool.query<InstallIdentity>(`select ${this.cols} from ${this.s}.installs where status = 'active' and matrix_user is not null`)).rows;
  }

  /** Is this one of this app's own names (any company)? Our own echo is never acted on. */
  async isOurs(matrixId: string): Promise<boolean> {
    return !!(await this.pool.query(`select 1 from ${this.s}.installs where matrix_user = $1 limit 1`, [matrixId])).rowCount;
  }

  async person(companyId: string, matrixId: string): Promise<Person | null> {
    const r = await this.pool.query<Person>(
      `select user_id as id, company_id, coalesce(name, 'a person') as name, coalesce(role, 'member') as role, matrix_id, chat_person from ${this.s}.people where company_id = $1 and matrix_id = $2`,
      [companyId, matrixId],
    );
    return r.rows[0] ?? null;
  }

  async personById(companyId: string, userId: string): Promise<Person | null> {
    const r = await this.pool.query<Person>(
      `select user_id as id, company_id, coalesce(name, 'a person') as name, coalesce(role, 'member') as role, matrix_id, chat_person from ${this.s}.people where company_id = $1 and user_id = $2 order by chat_person desc limit 1`,
      [companyId, userId],
    );
    if (r.rows[0]) return r.rows[0];
    // t017: a person a bridge relays for need not have a Matrix id of their own.
    const has = (await this.pool.query<{ ok: boolean }>('select to_regclass($1) is not null as ok', [`${this.s}.acted_for`])).rows[0]?.ok;
    if (!has) return null;
    const a = await this.pool.query<Person>(
      `select user_id as id, company_id, coalesce(name, 'a person') as name, coalesce(role, 'member') as role, null::text as matrix_id, false as chat_person from ${this.s}.acted_for where company_id = $1 and user_id = $2`,
      [companyId, userId],
    );
    return a.rows[0] ?? null;
  }

  /**
   * v3 S6: who is writing in the company's bus room — only another app on the bus (installs.bus_peers, written by
   * rooms-setup) is anyone there; a person, the reasoning agent or a stranger is not acted on in it.
   */
  async busSender(companyId: string, matrixId: string): Promise<Who | null> {
    const inst = await this.install(companyId);
    if (!inst || inst.status !== 'active') return null;
    const app = inst.bus_peers?.[matrixId];
    return typeof app === 'string' && /^[a-z][a-z0-9_]{0,40}$/.test(app) ? { cls: 'neop', actsFor: null, app } : null;
  }

  /**
   * Who is writing, for a road:
   *   client     — an allowed agent sender (installs.agent_senders) is agent/neop; a person must be linked AND on the
   *                app's allowlist as a person (people.chat_person); anyone else: null (a stranger, ignored).
   *   appservice — a linked person of the room's company is a person (the room's membership is the allowlist);
   *                otherwise an allowed agent sender; anyone else: null.
   */
  async sender(companyId: string, matrixId: string, road: 'client' | 'appservice'): Promise<Who | null> {
    const inst = await this.install(companyId);
    if (!inst || inst.status !== 'active') return null;
    const agent = inst.agent_senders.includes(matrixId) ? ({ cls: classOfNonPerson(matrixId), actsFor: inst.agent_acts_for?.[matrixId] ?? null } as const) : null;
    if (road === 'client' && agent) return agent;
    const p = await this.person(companyId, matrixId);
    if (p && (road === 'appservice' || p.chat_person)) return { cls: 'person', person: p };
    return agent;
  }
}
