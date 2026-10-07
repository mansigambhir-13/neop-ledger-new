import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISIONS, strictest, type Manifest, type Setting } from '@neop/contracts';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { Platform, PlatformError, PLATFORM_ISSUER } from './platform.ts';

const DESK_HTML = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'desk.html'), 'utf8');

// v3 S9 · everything here is the platform's own (people, Conversations, NeuralChat, the desk, the registry). No route
// reaches an app and none is for an app to call at run time: an app's data is read and changed on the database (as
// neos_desk, through the functions its migration file declares) and every word with it is a typed Matrix event.

export function platformApp(p: Platform): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof PlatformError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    p.log('error', { e: String(err), stack: (err as Error).stack });
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  app.get('/', (c) => c.html(DESK_HTML));
  app.get('/.well-known/registry-jwks.json', (c) => c.json(p.registry.jwks()));
  app.get('/live', (c) => c.json({ ok: true }));
  app.get('/metrics', async (c) => {
    // Closed unless a scrape token is configured (or explicitly opened for local dev): it carries company ids and spend.
    const tok = process.env.NEOS_METRICS_TOKEN;
    if (tok) {
      if (c.req.header('authorization') !== `Bearer ${tok}`) return c.text('unauthorized', 401);
    } else if (process.env.NEOS_METRICS_PUBLIC !== '1') return c.text('not found', 404);
    return c.text(await p.renderMetrics(), 200, { 'content-type': 'text/plain; version=0.0.4' });
  });

  // ── registry publish, by an app's BUILD (its registry credential; v3 §13 step 5 `neos publish`) ──────
  // Not a run-time API: no running backend holds this credential or calls anything here (v3 S9).
  const service = async (c: Context): Promise<string> => {
    const key = await p.authService(c.req.header('authorization'));
    if (!key) throw new PlatformError(401, 'unauthenticated', 'service credentials required');
    return key;
  };
  app.post('/internal/registry/publish', async (c) => {
    const key = await service(c);
    const b = await c.req.json();
    return c.json(await p.registry.submit(`app:${key}`, { kind: 'skill', key: b.key, version: b.version, owner_app: key, body: b.body, requires: b.requires ?? [], author: { sig: b.author_sig } }));
  });
  // v3 S7: no run-time registry fetch. A backend's packages are in its build; pinned skills are read from
  // neos_registry.skills with the app's own role. `neos install` fetches below (/api/registry/entry, /artifact).
  // v3 S8/S9: no /internal/* for backends at all — door credentials come from the secret store, LLM session tokens
  // from the runner, the board from the app's own schema, a hand-off to another app is a typed event in the bus room.

  // ── the NEOS app and desk, authenticated as a person ────────────────────
  const user = async (c: Context) => {
    const u = await p.authUser(c.req.header('authorization'));
    if (!u) throw new PlatformError(401, 'unauthenticated', 'sign in required');
    return u;
  };

  app.get('/api/me', async (c) => {
    const u = await user(c);
    const co = (await p.db.query('select name, slug, time_zone from neos.companies where id = $1', [u.company_id])).rows[0];
    return c.json({ ...u, company: co ?? null });
  });

  // The company's people (the Team view). Tokens are never returned: only a hash is stored.
  app.get('/api/users', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const r = await p.db.query('select id, name, email, role, matrix_user_id, created_at from neos.users where company_id = $1 order by created_at', [u.company_id]);
    return c.json({ users: r.rows });
  });

  app.get('/api/apps', async (c) => {
    await user(c);
    const r = await p.db.query("select key, manifest->>'name' as name, manifest->>'description' as description from neos.apps where status = 'active' order by key");
    return c.json({ apps: r.rows });
  });

  // What an installed app can do, with each ability's safety floor and the company's
  // current setting (including abilities switched off), for the controls screen.
  app.get('/api/apps/:app/abilities', async (c) => {
    const u = await user(c);
    const key = c.req.param('app');
    await p.assertInstalled(key, u.company_id);
    const r = await p.db.query<{ manifest: Manifest }>("select manifest from neos.apps where key = $1 and status = 'active'", [key]);
    if (!r.rows[0]) throw new PlatformError(404, 'not_found', 'no such app');
    const m = r.rows[0].manifest;
    const sb = await p.switchboard(u.company_id, key);
    const forced = new Set((sb.rules ?? []).filter((x: any) => x?.type === 'require_person').flatMap((x: any) => x.abilities ?? []));
    const inForce = (a: { key: string; kind: string; floor: Setting }) => {
      const s = strictest(a.floor, sb.settings?.[a.key]);
      return s === 'on' && a.kind === 'write' && forced.has(a.key) ? 'ask_first' : s;
    };
    const pkg = await p.packageAbilities(key, u.company_id);
    const doors = await p.doorLines(key, u.company_id, sb.settings ?? {});
    const settingOf = (k: string) => {
      const own = m.abilities.find((a) => a.key === k);
      const pk = pkg.find((a) => a.key === k);
      return own ? inForce(own) : pk ? inForce(pk) : null;
    };
    // A requirement another app owns (v3 §10, S6/S9) loads only as the gate offers it: the owner is whoever offers it in
    // neos_registry, and the line is this app's own borrowed line on its board — off until the company sets it, never
    // looser than the `uses` floor. The owner checks its own line when the typed ask arrives.
    const borrowedSetting = async (r: string): Promise<{ setting: Setting; from: string | null }> => {
      const owner = (await p.db.query<{ app: string }>("select app from neos_registry.abilities where app <> $1 and ability = $2 order by app limit 1", [key, r])).rows[0]?.app ?? null;
      const own = sb.settings?.[r] as Setting | undefined;
      if (!owner || own === undefined) return { setting: 'off', from: owner };
      const floor = (m.uses ?? []).find((x) => x.ability === r)?.floor ?? 'on';
      return { setting: strictest(floor, own), from: owner };
    };
    const skills = await Promise.all(
      (await p.skillLines(key, u.company_id, m)).map(async (sk) => {
        const setting = sb.settings?.[`skill:${sk.key}`] === 'off' ? 'off' : 'on';
        const needs = await Promise.all(
          sk.requires.map(async (r) => {
            const here = settingOf(r);
            if (here) return { key: r, setting: here, owner: key };
            const b = await borrowedSetting(r);
            return { key: r, setting: b.setting, owner: b.from };
          }),
        );
        const missing = needs.filter((n) => n.setting === 'off').map((n) => n.key);
        return { key: sk.key, from: sk.from, setting, needs, missing, loads: setting === 'on' && missing.length === 0 };
      }),
    );
    return c.json({
      switchboard_version: sb.version,
      abilities: [
        ...m.abilities.map((a) => ({
          key: a.key,
          title: a.title,
          description: a.description,
          kind: a.kind,
          floor: a.floor,
          company: sb.settings?.[a.key] ?? null,
          setting: inForce(a),
          forced_by_rule: forced.has(a.key),
          from: 'own',
          effects: a.effects ?? {},
          doors: a.doors ?? [],
        })),
        ...pkg.map((a) => ({
          key: a.key,
          title: a.title,
          description: `${a.description ? `${a.description} ` : ''}(From the ${a.package} package, v${a.package_version}.)`,
          kind: a.kind,
          floor: a.floor,
          company: sb.settings?.[a.key] ?? null,
          setting: inForce(a),
          forced_by_rule: forced.has(a.key),
          from: a.package,
          effects: a.effects ?? {},
          doors: a.doors ?? [],
        })),
      ],
      skills,
      // v3 §4: doors are switchboard lines too (`door:<key>`, on/off), shown like the others.
      doors,
    });
  });

  // The app's screens as data, for the desk's one renderer (WP §13).
  app.get('/api/apps/:app/blocks', async (c) => {
    const u = await user(c);
    await p.assertInstalled(c.req.param('app'), u.company_id);
    const r = await p.db.query<{ blocks: Record<string, unknown>; name: string }>("select blocks, manifest->>'name' as name from neos.apps where key = $1 and status = 'active'", [c.req.param('app')]);
    if (!r.rows[0]) throw new PlatformError(404, 'not_found', 'no such app');
    return c.json({ app: c.req.param('app'), name: r.rows[0].name, blocks: r.rows[0].blocks });
  });

  // Steps 1–6: stored in the conversation → NeuralChat picks an installed app → task row → tasks.open. Never blocks on the job.
  app.post('/api/ask', async (c) => {
    const u = await user(c);
    const b = await c.req.json().catch(() => ({}));
    if (typeof b.text !== 'string' || !b.text.trim()) throw new PlatformError(400, 'bad_request', 'text required');
    // Attachments are checked here only for shape and size; the app's documents door reads them.
    const att = b.attachments;
    if (att !== undefined) {
      const ok = Array.isArray(att) && att.length <= 5 && att.every((a: any) =>
        a && typeof a.filename === 'string' && a.filename.trim() && a.filename.length <= 200 &&
        (a.content_type === undefined || (typeof a.content_type === 'string' && a.content_type.length <= 200)) &&
        typeof a.content_base64 === 'string' && a.content_base64.length > 0 && a.content_base64.length <= 14_000_000);
      if (!ok) throw new PlatformError(400, 'bad_request', 'attachments: at most 5 files of { filename, content_type?, content_base64 }, each ≤ 10 MB');
    }
    return c.json(await p.ask(u, b.text, { app: typeof b.app === 'string' ? b.app : undefined, conversation_id: typeof b.conversation_id === 'string' ? b.conversation_id : undefined, attachments: att }));
  });

  // (5a) What NeuralChat sees: installed apps, what each can do, which need a yes.
  app.get('/api/registry', async (c) => {
    const u = await user(c);
    return c.json({ apps: await p.registryContext(u.company_id) });
  });

  app.post('/api/installs/:app', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    await p.installApp(u.company_id, c.req.param('app'), u.id);
    return c.json({ ok: true });
  });

  app.get('/api/conversations/:id', async (c) => {
    const u = await user(c);
    return c.json(await p.conversation(u, c.req.param('id')));
  });

  // (9) The answer, pushed: server-sent events for one conversation (R15).
  // EventSource cannot send headers: the client first gets a 5-minute token for one conversation
  // (never the person's long-lived credential in a URL, where proxies log it).
  app.post('/api/conversations/:id/stream-token', async (c) => {
    const u = await user(c);
    await p.conversation(u, c.req.param('id'));
    const token = await p.sign({ conversation_id: c.req.param('id'), company_id: u.company_id }, 'neos-stream', `user:${u.id}`, 300);
    return c.json({ token, expires_in: 300 });
  });

  app.get('/api/conversations/:id/events', async (c) => {
    const st = c.req.query('st');
    let u: { id: string; company_id: string };
    if (st) {
      const { jwtVerify, createLocalJWKSet } = await import('jose');
      try {
        const { payload } = await jwtVerify(st, createLocalJWKSet(p.opts.keys.jwks() as any), { issuer: PLATFORM_ISSUER, audience: 'neos-stream', algorithms: ['EdDSA'] });
        if (payload.conversation_id !== c.req.param('id')) throw new Error('wrong conversation');
        u = { id: String(payload.sub).slice(5), company_id: String(payload.company_id) };
      } catch {
        throw new PlatformError(401, 'unauthenticated', 'stream token invalid or expired');
      }
    } else {
      u = await user(c);
    }
    await p.conversation(u, c.req.param('id')); // ownership check
    let last = Number(c.req.query('after') ?? c.req.header('last-event-id') ?? 0);
    return streamSSE(c, async (stream) => {
      const until = Date.now() + 10 * 60_000;
      while (!stream.aborted && Date.now() < until) {
        const rows = (
          await p.db.query('select id, author, kind, body, task_id, at from neos.conversation_messages where conversation_id = $1 and id > $2 order by id limit 100', [
            c.req.param('id'),
            last,
          ])
        ).rows;
        for (const m of rows) {
          last = Number(m.id);
          await stream.writeSSE({ id: String(m.id), event: m.kind, data: JSON.stringify(m) });
        }
        if (!rows.length) await stream.writeSSE({ event: 'ping', data: '{}' });
        await stream.sleep(rows.length ? 50 : 1000);
      }
    });
  });

  // Timers (WP §7): an admin sets an app's schedules, naming the admin as the requester of every run. v3 S9: on the
  // app's own rows, as the desk, through <app>.set_schedule() / <app>.list_schedules() (templates t010, t018).
  app.get('/api/apps/:app/schedules', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    return c.json({ schedules: await p.listSchedules(u.company_id, c.req.param('app')) });
  });
  app.put('/api/apps/:app/schedules', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.ask !== 'string' || !b.ask.trim() || !b.rule || typeof b.rule !== 'object') throw new PlatformError(400, 'bad_request', 'ask and rule ({every, at, weekday?, day?}) required');
    if (b.id !== undefined && typeof b.id !== 'string') throw new PlatformError(400, 'bad_request', 'id must be a string');
    return c.json({ schedule: await p.setSchedule(u, c.req.param('app'), { id: b.id, ask: b.ask, rule: b.rule, enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined }) });
  });

  // The desk activity feed (C6): job steps and a2a hand-offs across the company's apps, newest first.
  // v3 S3: the steps are the apps' own rows (neos.v_activity, read as neos_desk); the a2a hand-offs are the platform's.
  app.get('/api/activity', async (c) => {
    const u = await user(c);
    return c.json({ activity: await p.activity(u.company_id, { kind: c.req.query('kind') ?? null, app: c.req.query('app') ?? null, limit: Math.min(Number(c.req.query('limit') ?? 100) || 100, 500) }) });
  });

  // v3 S9: no dead letters (no outbox consumer: each app's own presence mirrors its outbox) and no gateway keys to rotate.

  app.post('/api/tasks/:id/cancel', async (c) => {
    const u = await user(c);
    const b = await c.req.json().catch(() => ({}));
    return c.json(await p.cancelTask(u, c.req.param('id'), typeof b.reason === 'string' ? b.reason : undefined));
  });

  app.get('/api/tasks', async (c) => {
    const u = await user(c);
    // v3 S2: a card waiting for a person is the app's PROPOSED row (neos.v_desk_cards PENDING), read once per list.
    const r = await p.db.query(
      `with pending as materialized (select job_id, count(*)::int as n from neos.v_desk_cards where company_id = $1 and status = 'PENDING' group by job_id)
       select t.*,
              (select coalesce(sum(cost_micros), 0)::bigint from neos.llm_usage l where l.job_id = t.job_id) as cost_micros,
              coalesce((select n from pending where pending.job_id = t.job_id), 0) as pending_approvals
         from neos.tasks t where t.company_id = $1 order by t.created_at desc limit $2`,
      [u.company_id, Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)],
    );
    // v3 S3: open questions and steps are the apps' own rows (neos.v_open_questions, neos.v_activity), read once per list as the desk.
    const counts = await p.deskCounts(u.company_id);
    return c.json({ tasks: r.rows.map((t) => ({ ...t, open_questions: counts.questions.get(String(t.id)) ?? 0, steps: (t.job_id && counts.steps.get(`${t.app_key}:${t.job_id}`)) || 0 })) });
  });

  app.get('/api/tasks/:id', async (c) => {
    const u = await user(c);
    const t = await p.db.query('select * from neos.tasks where id = $1 and company_id = $2', [c.req.param('id'), u.company_id]);
    if (!t.rows[0]) throw new PlatformError(404, 'not_found', 'no such task');
    const msgs = await p.db.query('select author, kind, body, task_id, at from neos.conversation_messages where task_id = $1 order by id', [t.rows[0].id]);
    // v3 S3: the job's steps from the app's own rows (neos.v_activity) and the platform's a2a hand-offs.
    const act = { rows: t.rows[0].job_id ? await p.jobActivity(u.company_id, t.rows[0].job_id) : [] };
    const job = t.rows[0].job_id;
    const approvals = job
      ? await p.db.query(
          `select a.id, a.proposal_id, a.ability_key, a.args, a.card, a.fingerprint, a.expires_at, a.status, a.decision, a.feedback, a.decided_at, a.fingerprint_seen, a.proof, a.last_error, a.created_at, du.name as decided_by_name
             from neos.v_desk_cards a left join neos.users du on du.id = a.decided_by where a.job_id = $1 and a.company_id = $2 order by a.created_at`,
          [job, u.company_id],
        )
      : { rows: [] };
    const cost = job
      ? await p.db.query(`select coalesce(sum(cost_micros), 0)::bigint as micros, count(*)::int as calls, coalesce(sum(input_tokens + output_tokens), 0)::bigint as tokens from neos.llm_usage where job_id = $1 and company_id = $2`, [job, u.company_id])
      : { rows: [{ micros: 0, calls: 0, tokens: 0 }] };
    // v3 S1: a standing yes's uses are recorded in the app's own schema (<app>.grant_uses).
    const grants = { rows: job && t.rows[0].app_key ? await p.grantUsesForJob(t.rows[0].app_key, u.company_id, job) : [] };
    // v3 S3: the apps' own input waits (neos.v_questions), for this task and every a2a task under it.
    const questions = { rows: await p.questionsForTask(u.company_id, t.rows[0].id) };
    const c0 = cost.rows[0];
    return c.json({ task: t.rows[0], messages: msgs.rows, activity: act.rows, approvals: approvals.rows, questions: questions.rows, grant_uses: grants.rows, cost: { usd: Number(c0.micros) / 1e6, calls: c0.calls, tokens: Number(c0.tokens) } });
  });

  // v3 S2: the desk's cards are the apps' own proposal rows (neos.v_desk_cards; the waiting ones are exactly
  // neos.v_pending_approvals). A card's id is its proposal id; answering it calls <app>.answer_proposal().
  app.get('/api/desk', async (c) => {
    const u = await user(c);
    const r = await p.db.query(
      `select a.id, a.app_key, a.proposal_id, a.job_id, a.task_id, a.ability_key, a.args, a.card, a.fingerprint, a.expires_at, a.status, a.decision, a.feedback,
              a.decided_at, a.fingerprint_seen, du.name as decided_by_name, a.proof, a.last_error, a.created_at, t.ask as task_ask, t.requester as task_requester
         from neos.v_desk_cards a left join neos.users du on du.id = a.decided_by left join neos.tasks t on t.id = a.task_id
        where a.company_id = $1 order by (a.status = 'PENDING') desc, a.created_at desc limit 200`,
      [u.company_id],
    );
    return c.json({ cards: r.rows });
  });

  app.post('/api/desk/:id/answer', async (c) => {
    const u = await user(c);
    const b = await c.req.json().catch(() => ({}));
    if (!DECISIONS.includes(b.decision)) throw new PlatformError(400, 'bad_request', `decision must be one of ${DECISIONS.join(', ')}`);
    if (typeof b.fingerprint_seen !== 'string') throw new PlatformError(400, 'bad_request', 'fingerprint_seen required: a yes binds to what you saw');
    if (b.decision === 'change' && (typeof b.feedback !== 'string' || !b.feedback.trim())) throw new PlatformError(400, 'bad_request', 'say what to change');
    await p.answer(c.req.param('id'), u, b);
    return c.json({ ok: true });
  });

  // WP §8 `ask`: what the company's jobs are waiting to be told. An answer is information for the job,
  // never a yes. v3 S3: read from neos.v_open_questions / neos.v_questions and answered through <app>.answer_wait(),
  // both as neos_desk; recorded as this person's. A question's id is its wait id (an older id still maps).
  app.get('/api/questions', async (c) => {
    const u = await user(c);
    const s = c.req.query('status');
    if (s !== undefined && !['OPEN', 'ANSWERED', 'EXPIRED', 'STALE'].includes(s)) throw new PlatformError(400, 'bad_request', 'status must be OPEN, ANSWERED, EXPIRED or STALE');
    return c.json({ questions: await p.questions(u, { status: s ?? 'OPEN' }) });
  });

  app.post('/api/questions/:id/answer', async (c) => {
    const u = await user(c);
    const b = await c.req.json().catch(() => ({}));
    if (!b || typeof b.answers !== 'object' || b.answers === null || Array.isArray(b.answers)) throw new PlatformError(400, 'bad_request', 'answers (field → value) required');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.req.param('id'))) throw new PlatformError(404, 'not_found', 'no such question');
    return c.json(await p.answerQuestion(c.req.param('id'), { company_id: u.company_id, user_id: u.id }, b.answers, 'desk'));
  });

  // WP §12: the raw transcript of a job's assistant sessions — for an admin's audit, read from the app.
  app.get('/api/tasks/:id/transcript', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    return c.json(await p.transcript(u, c.req.param('id')));
  });

  app.get('/api/switchboards/:app', async (c) => {
    const u = await user(c);
    return c.json(await p.switchboard(u.company_id, c.req.param('app')));
  });
  app.put('/api/switchboards/:app', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const b = await c.req.json();
    return c.json({ version: await p.setSwitchboard(u.company_id, c.req.param('app'), u.id, b) });
  });

  // v3 S9: no vault and no document fetch. Door credentials live in the secret store, per (app, company), read by the
  // app's backend per call (scripts/deploy.sh door set). A kept document is downloaded from the app backend's own files
  // listener with the signed link its read handed out (template doors/documents/files.ts); the platform fetches nothing.

  app.post('/api/registry/packages', async (c) => {
    const u = await user(c);
    if (u.role !== 'operator') throw new PlatformError(403, 'denied', 'operators only');
    const b = await c.req.json();
    return c.json(await p.registry.submit(`user:${u.id}`, { kind: 'package', key: b.bundle?.manifest?.key, version: b.bundle?.manifest?.version, bundle: b.bundle, author: b.author ?? null }));
  });
  app.get('/api/registry/reviews', async (c) => {
    const u = await user(c);
    if (u.role !== 'operator') throw new PlatformError(403, 'denied', 'operators only');
    const r = await p.db.query("select * from neos.registry_reviews where status = 'PENDING' order by created_at");
    return c.json({ reviews: r.rows });
  });
  app.post('/api/registry/reviews/:id/answer', async (c) => {
    const u = await user(c);
    return c.json(await p.registry.review(u, c.req.param('id'), await c.req.json()));
  });
  // v3 S7: packages and skills are installed at build time (`neos install <app> <key>@<version>`, then the app's
  // next build and migration file); a company switches the lines they add on its switchboard. There is no
  // run-time install any more.
  const installAtBuild = async (c: Context) => {
    await user(c);
    throw new PlatformError(410, 'install_at_build', 'packages and registry skills are installed into an app at build time (neos install); switch their lines on the switchboard');
  };
  app.post('/api/registry/installs', installAtBuild);
  app.delete('/api/registry/installs', installAtBuild);
  // What `neos install` fetches: one signed entry, and a published package's artifact by hash. A build is run by
  // ops (an operator's token) or by an app's own build (its service secret); nothing here is secret or per-company.
  const builder = async (c: Context) => {
    const h = c.req.header('authorization') ?? '';
    if (h.startsWith('Service ')) return service(c);
    const u = await user(c);
    if (u.role !== 'operator') throw new PlatformError(403, 'denied', 'installing into a build is for operators and app builds');
    return `user:${u.id}`;
  };
  app.get('/api/registry/entry', async (c) => {
    await builder(c);
    return c.json({ entry: await p.registry.entry(c.req.query('key') ?? '', c.req.query('version') ?? '') });
  });
  app.get('/api/registry/artifact', async (c) => {
    await builder(c);
    const hash = c.req.query('hash') ?? '';
    return c.json({ hash, base64: (await p.registry.publishedArtifact(hash)).toString('base64') });
  });
  app.post('/api/registry/deprecate', async (c) => {
    const u = await user(c);
    const b = await c.req.json();
    await p.registry.deprecate(u, b.key, b.version);
    return c.json({ ok: true });
  });
  app.post('/api/registry/retire', async (c) => {
    const u = await user(c);
    const b = await c.req.json();
    await p.registry.retire(u, b.key, b.version);
    return c.json({ ok: true });
  });

  // Standing yeses (WP §5): "always do this within these limits". Admins create and withdraw
  // them; everyone can see them and what they have been used for this month.
  app.get('/api/grants', async (c) => {
    const u = await user(c);
    // v3 S1: read from each app's own <app>.grants and <app>.grant_uses (this month in the company's time zone).
    const rows = await p.listGrants(u.company_id);
    return c.json({ grants: rows.map((g) => ({ ...g, expired: new Date(g.expires_at) <= new Date() })) });
  });
  app.post('/api/grants', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const b = await c.req.json().catch(() => ({}));
    const appRow = (await p.db.query<{ manifest: Manifest }>('select manifest from neos.apps where key = $1', [b.app_key])).rows[0];
    if (!appRow) throw new PlatformError(404, 'not_found', 'no such app');
    await p.assertInstalled(b.app_key, u.company_id);
    const a = appRow.manifest.abilities.find((x) => x.key === b.ability_key);
    if (!a || a.kind !== 'write') throw new PlatformError(422, 'not_grantable', 'a standing yes covers one write ability of the app');
    const L = b.limits ?? {};
    for (const k of ['per_call_minor', 'per_month_minor']) {
      if (L[k] !== undefined && !(Number.isInteger(L[k]) && L[k] > 0)) throw new PlatformError(422, 'bad_limits', `${k} must be a positive whole number of minor units`);
    }
    if ((L.per_call_minor !== undefined || L.per_month_minor !== undefined) && !/^[A-Z]{3}$/.test(String(L.currency ?? ''))) {
      throw new PlatformError(422, 'bad_limits', 'an amount limit needs a currency');
    }
    if (a.effects?.money && L.per_call_minor === undefined && L.per_month_minor === undefined) {
      throw new PlatformError(422, 'bad_limits', 'a standing yes for money needs an amount limit');
    }
    if (L.recipients_allow !== undefined && (!Array.isArray(L.recipients_allow) || !L.recipients_allow.every((x: unknown) => typeof x === 'string' && /@/.test(x as string)))) {
      throw new PlatformError(422, 'bad_limits', 'recipients_allow must list email addresses');
    }
    const exp = new Date(b.expires_at);
    if (!(exp.getTime() > Date.now()) || exp.getTime() > Date.now() + 366 * 864e5) throw new PlatformError(422, 'bad_expiry', 'a standing yes must expire within a year');
    const limits = Object.fromEntries(['per_call_minor', 'per_month_minor', 'currency', 'recipients_allow'].filter((k) => L[k] !== undefined).map((k) => [k, L[k]]));
    const id = await p.createGrant({ company_id: u.company_id, app_key: b.app_key, ability_key: b.ability_key, limits, expires_at: exp, created_by: u.id });
    await p.audit({ company_id: u.company_id, actor: `user:${u.id}`, app_key: b.app_key, action: 'grant.created', ability_key: b.ability_key, outcome: id, detail: { limits, expires_at: exp.toISOString() } });
    return c.json({ id });
  });
  app.delete('/api/grants/:id', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const r = await p.revokeGrant(u.company_id, c.req.param('id'), u.id);
    if (!r?.changed) throw new PlatformError(404, 'not_found', 'no such standing yes');
    await p.audit({ company_id: u.company_id, actor: `user:${u.id}`, app_key: r.app_key, action: 'grant.revoked', ability_key: r.ability_key, outcome: c.req.param('id') });
    return c.json({ ok: true });
  });

  // v3 S6/S9: which other apps may ask an app for what is the bus room (membership, power levels) and each borrower's
  // own `uses` line on its switchboard (PUT /api/switchboards/:app) — there is no ACL table.

  // One audit trail (WP §8): every effectful call and every governance change, newest first.
  app.get('/api/audit', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const q = c.req.query();
    const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 500);
    // v3 §8 "one audit trail": what an app carried out is the app's own `operations` row (neos.v_operations, read as the
    // desk) — asked for with action=app.operation, paged by time (`before` = the last row's `at`); everything else is
    // the platform's own trail, paged by id.
    if (q.action && q.action.length >= 4 && 'app.operation'.startsWith(q.action)) {
      const before = q.before ? new Date(/^\d+$/.test(q.before) ? Number(q.before) : q.before) : null;
      if (before && Number.isNaN(before.getTime())) throw new PlatformError(400, 'bad_request', 'before is a time');
      const ops = (await p.operations(u.company_id, { app: q.app ?? null, before, limit })).filter((x) => !q.actor || x.actor === q.actor);
      return c.json({ rows: ops.map((x) => ({ ...x, actor_name: null })), next_before: ops.length === limit ? new Date(ops.at(-1)!.at).toISOString() : null });
    }
    const r = await p.db.query(
      `select id, at, actor, app_key, action, ability_key, idem_key, request_id, outcome, detail from neos.audit
        where company_id = $1
          and ($2::text is null or app_key = $2) and ($3::text is null or action like $3 || '%')
          and ($4::text is null or actor = $4) and ($5::bigint is null or id < $5)
        order by id desc limit $6`,
      [u.company_id, q.app ?? null, q.action ?? null, q.actor ?? null, q.before ?? null, limit],
    );
    const actors = [...new Set(r.rows.map((x) => x.actor).filter((a: string) => a?.startsWith('user:')).map((a: string) => a.slice(5)))];
    const names = actors.length ? (await p.db.query('select id, name from neos.users where id = any($1::uuid[])', [actors])).rows : [];
    const byId = new Map(names.map((n) => [String(n.id), n.name]));
    return c.json({ rows: r.rows.map((x) => ({ ...x, id: Number(x.id), actor_name: x.actor?.startsWith('user:') ? (byId.get(x.actor.slice(5)) ?? null) : null })), next_before: r.rows.length === limit ? Number(r.rows.at(-1).id) : null });
  });

  // The registry as a person sees it (WP §10): what can be added, what it offers and needs,
  // signed versions, and what this company has pinned.
  app.get('/api/registry/catalog', async (c) => {
    const u = await user(c);
    const entries = await p.db.query(
      `select key, version, kind, owner_app, offers, requires, status, platform_sig is not null as signed, content_hash, published_at, deprecated_at
         from neos.registry_entries where status in ('published', 'deprecated') order by key, published_at desc nulls last`,
    );
    // v3 S7: pinned = installed into an app's build (its manifest); the same for every company that has the app.
    const apps = new Set((await p.db.query<{ app_key: string }>("select app_key from neos.installs where company_id = $1 and status = 'active'", [u.company_id])).rows.map((r) => r.app_key));
    const installs = { rows: (await p.registry.pins()).filter((x) => apps.has(x.app)).map((x) => ({ host_app: x.app, entry_key: x.key, pinned_version: x.version, status: 'active' })) };
    const byKey = new Map<string, any>();
    for (const e of entries.rows) {
      const cur = byKey.get(e.key);
      if (!cur) byKey.set(e.key, { ...e, versions: [e.version] });
      else cur.versions.push(e.version);
    }
    return c.json({
      entries: [...byKey.values()].map((e) => {
        const inst = installs.rows.filter((i) => i.entry_key === e.key);
        return { ...e, latest: e.version, installs: inst, update_available: inst.some((i) => i.pinned_version !== e.version) };
      }),
    });
  });

  // Every switchboard version (WP §4: "change the list and the next call behaves differently").
  app.get('/api/switchboards/:app/history', async (c) => {
    const u = await user(c);
    // v3 S1: replayed from the app's own <app>.switchboard_history (one entry per saved version).
    const app = c.req.param('app');
    const versions = /^[a-z][a-z0-9_]{0,40}$/.test(app) ? await p.boards.history(app, u.company_id, 50) : [];
    const ids = [...new Set(versions.map((v) => /^user:([0-9a-f-]{36})$/i.exec(v.updated_by ?? '')?.[1]).filter(Boolean))] as string[];
    const names = ids.length ? new Map((await p.db.query<{ id: string; name: string }>('select id::text as id, name from neos.users where id = any($1::uuid[])', [ids])).rows.map((x) => [x.id, x.name])) : new Map<string, string>();
    return c.json({
      versions: versions.map(({ updated_by, ...v }) => ({ ...v, updated_by_name: names.get(/^user:([0-9a-f-]{36})$/i.exec(updated_by ?? '')?.[1] ?? '') ?? null })),
    });
  });

  // What the assistant has cost: today (company time zone) and this month, against the caps.
  app.get('/api/usage/:app', async (c) => {
    const u = await user(c);
    const sb = await p.switchboard(u.company_id, c.req.param('app'));
    const tz = sb.company.time_zone;
    const r = await p.db.query(
      `select coalesce(sum(cost_micros) filter (where (at at time zone $3)::date = (now() at time zone $3)::date), 0)::bigint as today,
              coalesce(sum(cost_micros) filter (where date_trunc('month', at at time zone $3) = date_trunc('month', now() at time zone $3)), 0)::bigint as month,
              count(*) filter (where outcome = 'refused_budget' and (at at time zone $3)::date = (now() at time zone $3)::date)::int as refused_today,
              coalesce(sum(input_tokens + output_tokens) filter (where (at at time zone $3)::date = (now() at time zone $3)::date), 0)::bigint as tokens_today
         from neos.llm_usage where company_id = $1 and app_key = $2`,
      [u.company_id, c.req.param('app'), tz],
    );
    const x = r.rows[0];
    return c.json({
      today_usd: Number(x.today) / 1e6,
      month_usd: Number(x.month) / 1e6,
      tokens_today: Number(x.tokens_today),
      refused_today: x.refused_today,
      per_job_cap_usd: Number(sb.budget?.per_job_usd ?? 5),
      per_day_cap_usd: Number(sb.budget?.per_day_usd ?? 50),
    });
  });

  // Reads for blocks (the screens: home tile, pages, reports). v3 S9: on the database, as the desk, through
  // <app>.block_read(ability, args) (template t018) — only the reads the app declared in its own migration file, under
  // the person's company (row-level security). The app's own read handler runs the same SQL, so what the screen shows
  // is what the assistant sees. Anything the app did not declare is 403 not_declared; the platform never calls the app.
  app.post('/api/apps/:app/read/:ability', async (c) => {
    const u = await user(c);
    const args = await c.req.json().catch(() => ({}));
    return c.json({ result: await p.blockRead(u, c.req.param('app'), c.req.param('ability'), args) });
  });

  return app;
}
