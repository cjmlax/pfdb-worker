import { randomUUID, createHash } from 'node:crypto';
import { schedule as cronSchedule } from 'node-cron';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config';
import {
  insertSubmission, insertSubmissions, listBySubmitter, many, pendingPayloadValues, run, type NewSubmission,
} from '../db';
import { clientIp } from '../clientIp';
import { connectedAccounts } from '../zitadel';
import { resolveFieldId, resolveTableId, teableFindRecords, teableGetRecordById } from '../teable';
import { mapLimit } from '../async';
import { requireUser, optionalUser } from '../userAuth';
import {
  upsertUser, submitFlairRequest, clearFlairRequest, clearFlair, confirmFlairCode, getProfile, getUser, getUsers,
  setDisplaySource, setShowCredit, publicDisplayName,
  markWeeklyCompleted, clearWeeklyCompleted, completedWeeklySetIds,
} from '../users';
import {
  MAX_NAME, MAX_PRESETS, cleanName, cleanHabitats, listWheelPresets, createWheelPreset, overwriteWheelPreset,
  deleteWheelPreset, type SaveResult,
} from '../wheelPresets';
import { listActiveAlerts } from '../alerts';
import { getHandler, listHandlers } from '../handlers/registry';
import { errorMessage, notify } from '../notify';
import { getFrogStats } from '../tasks/frogStatsCache';
import { getDailyFrog, isServableDate, todayUtc } from '../tasks/dailyFrog';
import { broadcastSse } from '../sse';
import { storeScreenshot } from '../imageProcess';

// The { id, title } references in a Teable link cell — a single one or an array.
function linkCells(val: unknown): { id: string; title: string }[] {
  const arr = Array.isArray(val) ? val : val ? [val] : [];
  return arr
    .filter((v): v is { id: unknown; title?: unknown } => !!v && typeof v === 'object' && 'id' in v)
    .map(v => ({ id: String(v.id), title: String(v.title ?? '') }));
}

// Tables exposed via the public export API. Slugs become URL path segments and
// CSV filenames, so keep them lowercase and URL-safe. Table IDs are resolved by
// the Teable display name at request time (cached), not configured.
const EXPORT_TABLES: Record<string, { label: string; tableName: string }> = {
  frogs:  { label: 'Frogs',         tableName: 'Froggies' },
  breeds: { label: 'Breeds',        tableName: 'Breeds' },
  pairs:     { label: 'Frog Pairs', tableName: 'Frog Pairs' },
  mutations: { label: 'Mutations',  tableName: 'Mutations' },
  weekly: { label: 'Weekly Sets',   tableName: 'Weekly Sets' },
};

// Persistent export state: hash + timestamp for each table, kept in Postgres so
// it survives restarts and failovers. Held in memory between writes.
interface ExportEntry { hash: string; exportedAt: string }
const exportState = new Map<string, ExportEntry>();

async function loadState(): Promise<void> {
  const rows = await many<{ slug: string; hash: string; exported_at: string }>(`SELECT * FROM export_state`);
  for (const r of rows) exportState.set(r.slug, { hash: r.hash, exportedAt: r.exported_at });
}

async function saveState(slug: string, entry: ExportEntry): Promise<void> {
  exportState.set(slug, entry);
  try {
    await run(
      `INSERT INTO export_state (slug, hash, exported_at) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET hash = excluded.hash, exported_at = excluded.exported_at`,
      [slug, entry.hash, entry.exportedAt],
    );
  } catch { /* non-fatal — state remains correct in memory until next restart */ }
}

// Most items one batch submit may carry. Sized to comfortably cover every frog
// currently missing stats, while bounding the Teable lookups one request makes.
const MAX_BATCH = 500;
// Most screenshots one batch request may carry — each is held in memory until
// the request is processed, so the website splits larger batches.
const MAX_BATCH_FILES = 10;

function hashIp(ip: string): string {
  return createHash('sha256').update(`${ip}|${config.ipHashSecret}`).digest('hex').slice(0, 16);
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export async function registerPublicRoutes(app: FastifyInstance) {
  await loadState();

  // Advertises the accepted submission types (handy for the website / debugging).
  app.get('/api/types', async () =>
    listHandlers().map((h) => ({ type: h.type, label: h.label, acceptsScreenshot: !!h.acceptsScreenshot })),
  );

  // Active site-wide announcement banners, newest first. Public — no auth, so
  // the SPA can show maintenance/outage notices to anonymous visitors too.
  app.get('/api/alerts', async () =>
    (await listActiveAlerts()).map(a => ({
      id: a.id,
      message: a.message,
      level: a.level,
      createdAt: a.created_at,
    })),
  );

  // The signed-in user's own profile. Records/refreshes the user on every call
  // (so the directory builds itself as people sign in) and returns their badges
  // and linked platforms (re-read from Zitadel each time).
  app.get('/api/me', { preHandler: requireUser }, async (req) => {
    const { sub, username } = req.user!;
    await upsertUser(sub, username, await connectedAccounts(sub));
    return getProfile(sub);
  });

  // Which name the site shows for the user: 'pfdb' (Friend Code) or a connected
  // platform key. Stored server-side so public credits can use it.
  app.put<{ Body: { source?: string } }>(
    '/api/me/display-source',
    { preHandler: requireUser },
    async (req, reply) => {
      const { sub, username } = req.user!;
      await upsertUser(sub, username, await connectedAccounts(sub));
      const source = typeof req.body?.source === 'string' ? req.body.source : '';
      if (!(await setDisplaySource(sub, source))) return reply.code(400).send({ error: 'Unknown display name source.' });
      return getProfile(sub);
    },
  );

  // Opt in/out of being named in public mutation credits.
  app.put<{ Body: { show?: unknown } }>(
    '/api/me/show-credit',
    { preHandler: requireUser },
    async (req, reply) => {
      const { sub, username } = req.user!;
      await upsertUser(sub, username);
      if (typeof req.body?.show !== 'boolean') return reply.code(400).send({ error: '`show` must be true or false.' });
      await setShowCredit(sub, req.body.show);
      return getProfile(sub);
    },
  );

  // Public credit names for Frog Pairs submitters: ?subs=a,b → { a: 'Name' }.
  // Subs that are unknown, opted out, or have no name are left out. Only the display name
  // the user chose is exposed — never the sub's other accounts.
  app.get<{ Querystring: { subs?: string } }>('/api/credits', async (req) => {
    const subs = [...new Set(String(req.query.subs ?? '').split(','))]
      .filter(s => /^[\w-]{1,128}$/.test(s))
      .slice(0, 50);
    const names: Record<string, string> = {};
    for (const user of await getUsers(subs)) {
      const name = user.show_credit !== 0 && publicDisplayName(user);
      if (name) names[user.sub] = name;
    }
    return names;
  });

  // Submit an in-game Friend Code for review. Held as a 'pending' request; the
  // admin sends the in-game friend request and sets a confirmation passphrase,
  // then the user confirms (below) to publish it. Capped and trimmed.
  app.post<{ Body: { code?: string } }>(
    '/api/me/flair',
    { preHandler: requireUser },
    async (req, reply) => {
      const { sub, username } = req.user!;
      await upsertUser(sub, username);
      const code = typeof req.body?.code === 'string' ? req.body.code.trim().slice(0, 80) : '';
      if (!code) return reply.code(400).send({ error: 'A friend code is required.' });
      await submitFlairRequest(sub, code);
      notify('flair.requested', {
        id: sub,
        type: 'flair',
        summary: `Friend code: ${code} — from ${username ?? sub}`,
        createdAt: new Date().toISOString(),
      });
      return getProfile(sub);
    },
  );

  // Cancel/withdraw an active request, or — if there's no active request — clear
  // an already-approved live Friend Code. Same "remove my code" action from the
  // user's perspective; which one applies depends on their current state.
  app.delete('/api/me/flair', { preHandler: requireUser }, async (req) => {
    const { sub, username } = req.user!;
    await upsertUser(sub, username);
    const user = await getUser(sub);
    if (user?.flair_status) await clearFlairRequest(sub);
    else await clearFlair(sub);
    return getProfile(sub);
  });

  // Confirm a 'sent' request with the passphrase the admin provided out-of-band.
  // On a (case-insensitive) match the friend code is published to the live flair.
  app.post<{ Body: { passphrase?: string } }>(
    '/api/me/flair/confirm',
    { preHandler: requireUser },
    async (req, reply) => {
      const { sub, username } = req.user!;
      await upsertUser(sub, username);
      const passphrase = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
      if (!passphrase.trim()) return reply.code(400).send({ error: 'Enter the confirmation code.' });
      const ok = await confirmFlairCode(sub, passphrase);
      return reply.send({ ok, profile: await getProfile(sub) });
    },
  );

  // The signed-in user's completed Weekly Sets — Teable record ids, used to
  // render the checkbox column and "hide completed" filter client-side.
  app.get('/api/me/weekly-completions', { preHandler: requireUser }, async (req) => {
    const { sub, username } = req.user!;
    await upsertUser(sub, username);
    return completedWeeklySetIds(sub);
  });

  app.put<{ Params: { id: string } }>(
    '/api/me/weekly-completions/:id',
    { preHandler: requireUser },
    async (req) => {
      const { sub, username } = req.user!;
      await upsertUser(sub, username);
      await markWeeklyCompleted(sub, req.params.id);
      return completedWeeklySetIds(sub);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/me/weekly-completions/:id',
    { preHandler: requireUser },
    async (req) => {
      const { sub, username } = req.user!;
      await upsertUser(sub, username);
      await clearWeeklyCompleted(sub, req.params.id);
      return completedWeeklySetIds(sub);
    },
  );

  // The signed-in user's saved Colour Wheel presets. Each write returns the
  // full list, sorted by name.
  app.get('/api/me/wheel-presets', { preHandler: requireUser }, async (req) => {
    const { sub, username } = req.user!;
    await upsertUser(sub, username);
    return listWheelPresets(sub);
  });

  const presetError = (result: SaveResult) => ({
    ok:        null,
    limit:     `You can save up to ${MAX_PRESETS} presets. Overwrite or delete one first.`,
    duplicate: 'You already have a preset with that name.',
    missing:   'That preset no longer exists.',
  })[result];

  app.post<{ Body: { name?: unknown; habitats?: unknown } }>(
    '/api/me/wheel-presets',
    { preHandler: requireUser },
    async (req, reply) => {
      const { sub, username } = req.user!;
      const name = cleanName(req.body?.name);
      const habitats = cleanHabitats(req.body?.habitats);
      if (!name) return reply.code(400).send({ error: `Name the preset (up to ${MAX_NAME} characters).` });
      if (!habitats) return reply.code(400).send({ error: 'That wheel can\'t be saved.' });
      await upsertUser(sub, username);
      const result = await createWheelPreset(sub, name, habitats);
      if (result !== 'ok') return reply.code(409).send({ error: presetError(result) });
      return listWheelPresets(sub);
    },
  );

  app.put<{ Params: { id: string }; Body: { habitats?: unknown } }>(
    '/api/me/wheel-presets/:id',
    { preHandler: requireUser },
    async (req, reply) => {
      const { sub } = req.user!;
      const habitats = cleanHabitats(req.body?.habitats);
      if (!habitats) return reply.code(400).send({ error: 'That wheel can\'t be saved.' });
      const result = await overwriteWheelPreset(sub, req.params.id, habitats);
      if (result !== 'ok') return reply.code(404).send({ error: presetError(result) });
      return listWheelPresets(sub);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/me/wheel-presets/:id',
    { preHandler: requireUser },
    async (req) => {
      const { sub } = req.user!;
      await deleteWheelPreset(sub, req.params.id);
      return listWheelPresets(sub);
    },
  );

  // The signed-in user's own submission history, newest first, with statuses.
  app.get('/api/me/submissions', { preHandler: requireUser }, async (req) =>
    (await listBySubmitter(req.user!.sub)).map(r => ({
      id: r.id,
      type: r.type,
      summary: r.summary,
      status: r.status,
      reviewerNote: r.reviewer_note,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
    })),
  );

  // The signed-in user's credited mutations, read live from Teable: every Frog
  // Pairs record whose Submitter is this user and that has at least one mutation,
  // with its mutations grouped under it. Link titles are Frog_IDs, so each frog
  // is looked up once for its full name.
  app.get('/api/me/mutations', { preHandler: requireUser }, async (req) => {
    const pairsId = await resolveTableId('Frog Pairs');
    const pairField = (dbFieldName: string) => resolveFieldId(pairsId, { dbFieldName });
    const [submitterF, mutationsF, frogAF, frogBF] = await Promise.all(
      ['submitter', 'mutations', 'frogA', 'frogb'].map(pairField),
    );
    const pairs = await teableFindRecords(pairsId, {
      conjunction: 'and',
      filterSet: [
        { fieldId: submitterF, operator: 'is', value: req.user!.sub },
        { fieldId: mutationsF, operator: 'isNotEmpty', value: null },
      ],
    }, 1000);

    const mutId = await resolveTableId('Mutations');
    const mutField = (dbFieldName: string) => resolveFieldId(mutId, { dbFieldName });
    const [typeF, resultF, lostF] = await Promise.all(['type', 'result', 'lost'].map(mutField));
    const mutIds = pairs.flatMap(pair => linkCells(pair.fields[mutationsF]).map(m => m.id));
    const mutations = new Map(await mapLimit(mutIds, 8, async id => [id, await teableGetRecordById(mutId, id)] as const));

    const frogsId = await resolveTableId('Froggies');
    const nameF = await resolveFieldId(frogsId, { dbFieldName: 'fullname' });
    const frogId = (val: unknown) => linkCells(val)[0]?.id ?? null;
    const frogIds = new Set([
      ...pairs.flatMap(pair => [pair.fields[frogAF], pair.fields[frogBF]]),
      ...[...mutations.values()].flatMap(m => (m ? [m[resultF], m[lostF]] : [])),
    ].map(frogId).filter((id): id is string => !!id));
    const names = new Map(await mapLimit([...frogIds], 8, async id =>
      [id, String((await teableGetRecordById(frogsId, id))?.[nameF] ?? '')] as const));
    const frogName = (val: unknown) => {
      const id = frogId(val);
      return id ? names.get(id) || null : null;
    };

    return pairs.map(pair => ({
      id: pair.id,
      frogA: frogName(pair.fields[frogAF]) ?? '',
      frogB: frogName(pair.fields[frogBF]) ?? '',
      mutations: linkCells(pair.fields[mutationsF]).flatMap(({ id }) => {
        const m = mutations.get(id);
        return m ? [{ id, type: String(m[typeF] ?? ''), result: frogName(m[resultF]) ?? '', lost: frogName(m[lostF]) }] : [];
      }),
    })).filter(p => p.mutations.length > 0);
  });

  // Public submission endpoint. Accepts multipart/form-data with fields:
  //   type     — handler key (e.g. "combo")
  //   payload  — JSON string validated by that handler's schema
  //   hp_url   — honeypot; real users leave it empty
  //   screenshot — optional image file
  app.post(
    '/api/submit',
    { preHandler: optionalUser, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      let typeStr = '';
      let payloadStr = '';
      let honeypot = '';
      let fileBuf: Buffer | null = null;

      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (part.fieldname === 'screenshot') {
              const ext = IMAGE_EXT[part.mimetype];
              const buf = await part.toBuffer();
              if (ext && buf.length > 0) {
                fileBuf = buf;
              }
            } else {
              await part.toBuffer(); // drain unexpected files
            }
          } else if (part.fieldname === 'type') {
            typeStr = String(part.value);
          } else if (part.fieldname === 'payload') {
            payloadStr = String(part.value);
          } else if (part.fieldname === 'hp_url') {
            honeypot = String(part.value);
          }
        }
      } catch (e) {
        if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.code(413).send({ error: 'screenshot too large' });
        }
        throw e;
      }

      // Honeypot tripped → pretend success and silently drop.
      if (honeypot.trim() !== '') return reply.send({ ok: true });

      const handler = getHandler(typeStr);
      if (!handler) return reply.code(400).send({ error: 'unknown submission type' });
      if (handler.requiresScreenshot && !fileBuf) return reply.code(400).send({ error: 'A screenshot is required.' });

      let payload: unknown;
      try {
        payload = JSON.parse(payloadStr || '{}');
      } catch {
        return reply.code(400).send({ error: 'invalid payload JSON' });
      }

      const parsed = handler.schema.safeParse(payload);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'validation failed', detail: parsed.error.flatten() });
      }

      if (handler.preSubmit) {
        try {
          await handler.preSubmit(parsed.data);
        } catch (e) {
          return reply.code(409).send({ error: e instanceof Error ? e.message : 'Submission not allowed.' });
        }
      }

      const id = randomUUID();
      let screenshot: string | null = null;
      let screenshotOriginal: string | null = null;
      if (fileBuf && handler.acceptsScreenshot) {
        ({ screenshot, original: screenshotOriginal } =
          await storeScreenshot(id, fileBuf, { autoCrop: !!handler.autoCropScreenshot }));
      }

      // Surface the attribution link (if any) in the review note column.
      const data = parsed.data as { sourceLink?: string };
      const ipHash = hashIp(clientIp(req));

      const summary = handler.summarize(parsed.data);
      const createdAt = new Date().toISOString();

      await insertSubmission({
        id,
        type: handler.type,
        payload: JSON.stringify(parsed.data),
        summary,
        screenshot,
        screenshot_original: screenshotOriginal,
        submitter_note: data.sourceLink ?? null,
        submitter_sub: req.user?.sub ?? null,
        submitter_name: req.user?.username ?? null,
        source_ip: ipHash,
        created_at: createdAt,
        batch_id: null,
      });

      // Also record the user in the directory so the admin can badge them later.
      if (req.user) await upsertUser(req.user.sub, req.user.username);

      req.log.info({ id, type: handler.type, submitter: req.user?.username ?? null }, 'submission received');
      notify('submission.created', { id, type: handler.type, summary, submitterNote: data.sourceLink, createdAt });
      broadcastSse('submission', { id, type: handler.type, summary });
      return reply.send({ ok: true, id });
    },
  );

  // Frog ids that already have a stats submission awaiting review, so the
  // website can hide them from the missing-stats list.
  app.get('/api/frog-stats/pending', async () => pendingPayloadValues('frogStats', 'frogId'));

  // Home page frog count + highest value, served from the worker's daily cache.
  app.get('/api/stats/frogs', async (req, reply) => {
    try {
      const stats = await getFrogStats();
      reply.header('Cache-Control', 'public, max-age=300');
      return stats;
    } catch (err) {
      req.log.warn({ err: errorMessage(err) }, 'frog stats: unavailable');
      return reply.code(502).send({ error: 'Frog stats are unavailable right now.' });
    }
  });

  // PFDB Frog of the Day for ?date=YYYY-MM-DD (yesterday–tomorrow in UTC, so any
  // time zone's current day); anything else — or no date — gets today in UTC.
  app.get<{ Querystring: { date?: string } }>('/api/stats/daily-frog', async (req, reply) => {
    const asked = req.query.date ?? '';
    const date = isServableDate(asked) ? asked : todayUtc();
    try {
      const frog = await getDailyFrog(date);
      reply.header('Cache-Control', 'public, max-age=300');
      return frog;
    } catch (err) {
      req.log.warn({ err: errorMessage(err), date }, 'daily frog: unavailable');
      return reply.code(502).send({ error: 'The frog of the day is unavailable right now.' });
    }
  });

  // Mutation record ids that already have a completion awaiting review.
  app.get('/api/mutation-completions/pending', async () => pendingPayloadValues('mutationCompletion', 'mutationId'));

  // Submits many items of one type in a single request. Each item becomes its
  // own pending submission, reviewed independently; the response reports
  // per-item acceptance so the website can show what was refused and why.
  //   JSON:      { type, payloads: [...], hp_url }
  //   multipart: the same three as fields (payloads as a JSON string), plus a
  //              file "screenshot.<index>" for each item that has one.
  app.post<{ Body: { type?: unknown; payloads?: unknown; hp_url?: unknown } }>(
    '/api/submit/batch',
    { preHandler: optionalUser, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      let body: { type?: unknown; payloads?: unknown; hp_url?: unknown } = req.body ?? {};
      const files = new Map<number, Buffer>();
      if (req.isMultipart()) {
        body = {};
        try {
          for await (const part of req.parts({ limits: { files: MAX_BATCH_FILES } })) {
            if (part.type === 'file') {
              const index = /^screenshot\.(\d+)$/.exec(part.fieldname)?.[1];
              const buf = await part.toBuffer();
              if (index !== undefined && IMAGE_EXT[part.mimetype] && buf.length > 0) files.set(Number(index), buf);
            } else if (part.fieldname === 'payloads') {
              try { body.payloads = JSON.parse(String(part.value)); }
              catch { return reply.code(400).send({ error: 'invalid payloads JSON' }); }
            } else if (part.fieldname === 'type' || part.fieldname === 'hp_url') {
              body[part.fieldname] = String(part.value);
            }
          }
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'screenshot too large' });
          if (code === 'FST_FILES_LIMIT') return reply.code(413).send({ error: `too many screenshots (max ${MAX_BATCH_FILES} per request)` });
          throw e;
        }
      }

      // Honeypot tripped → pretend success and silently drop.
      if (typeof body.hp_url === 'string' && body.hp_url.trim() !== '') return reply.send({ ok: true, results: [] });

      const handler = getHandler(typeof body.type === 'string' ? body.type : '');
      if (!handler) return reply.code(400).send({ error: 'unknown submission type' });

      const payloads = body.payloads;
      if (!Array.isArray(payloads) || payloads.length === 0) {
        return reply.code(400).send({ error: 'nothing to submit' });
      }
      if (payloads.length > MAX_BATCH) {
        return reply.code(400).send({ error: `too many items (max ${MAX_BATCH})` });
      }

      const checked = await mapLimit(payloads, 8, async (raw, index): Promise<{ data: unknown } | { error: string }> => {
        if (handler.requiresScreenshot && !files.has(index)) return { error: 'A screenshot is required.' };
        const parsed = handler.schema.safeParse(raw);
        if (!parsed.success) {
          return { error: parsed.error.issues.map(i => `${i.path.join('.') || 'item'}: ${i.message}`).join('; ') };
        }
        try {
          await handler.preSubmit?.(parsed.data);
        } catch (e) {
          return { error: e instanceof Error ? e.message : 'Submission not allowed.' };
        }
        return { data: parsed.data };
      });

      const createdAt = new Date().toISOString();
      const ipHash = hashIp(clientIp(req));
      const batchId = randomUUID();
      const seen = new Set<string>();
      const shots: { id: string; buf: Buffer }[] = [];
      const results: ({ index: number; ok: true; id: string } | { index: number; ok: false; error: string })[] = [];
      const rows: NewSubmission[] = [];
      const summaries: string[] = [];

      checked.forEach((c, index) => {
        if ('error' in c) { results.push({ index, ok: false, error: c.error }); return; }
        const key = handler.dedupeKey?.(c.data);
        if (key !== undefined) {
          if (seen.has(key)) { results.push({ index, ok: false, error: 'Duplicate of another item in this submission.' }); return; }
          seen.add(key);
        }
        const id = randomUUID();
        const summary = handler.summarize(c.data);
        const shot = handler.acceptsScreenshot ? files.get(index) : undefined;
        if (shot) shots.push({ id, buf: shot });
        rows.push({
          id,
          type: handler.type,
          payload: JSON.stringify(c.data),
          summary,
          screenshot: null,
          screenshot_original: null,
          submitter_note: null,
          submitter_sub: req.user?.sub ?? null,
          submitter_name: req.user?.username ?? null,
          source_ip: ipHash,
          created_at: createdAt,
          batch_id: batchId,
        });
        summaries.push(summary);
        results.push({ index, ok: true, id });
      });

      if (rows.length > 0) {
        for (const { id, buf } of shots) {
          const row = rows.find(r => r.id === id)!;
          ({ screenshot: row.screenshot, original: row.screenshot_original } =
            await storeScreenshot(id, buf, { autoCrop: !!handler.autoCropScreenshot }));
        }
        await insertSubmissions(rows);
        if (req.user) await upsertUser(req.user.sub, req.user.username);

        req.log.info({ type: handler.type, count: rows.length, submitter: req.user?.username ?? null }, 'batch submission received');
        const shown = summaries.slice(0, 10).join('\n');
        const more = summaries.length > 10 ? `\n…and ${summaries.length - 10} more` : '';
        notify('submission.created', {
          id: rows[0].id,
          type: handler.type,
          summary: summaries.length === 1 ? summaries[0] : `${summaries.length} submissions:\n${shown}${more}`,
          createdAt,
        });
        for (const r of rows) broadcastSse('submission', { id: r.id, type: handler.type, summary: r.summary });
      }

      return reply.send({ ok: true, results });
    },
  );

  // Fetches every export table, computes its hash, and persists the result.
  // Runs once shortly after startup and then every 24 hours.
  async function refreshHashes() {
    app.log.info('export hash refresh started');
    for (const [slug, { tableName }] of Object.entries(EXPORT_TABLES)) {
      try {
        const tableId = await resolveTableId(tableName);
        const res = await fetch(`${config.teable.baseUrl}/api/export/${tableId}`, {
          headers: { Authorization: `Bearer ${config.teable.token}` },
        });
        if (!res.ok) {
          app.log.warn({ slug, status: res.status }, 'hash refresh: Teable export failed');
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const hash = createHash('sha256').update(buf).digest('hex').slice(0, 8);
        await saveState(slug, { hash, exportedAt: new Date().toISOString() });
      } catch (err) {
        app.log.warn({ slug, err }, 'hash refresh: fetch failed');
      }
    }
    app.log.info('export hash refresh complete');
  }

  setTimeout(refreshHashes, 10_000); // run once after startup settles
  cronSchedule(config.export.hashRefreshCron, refreshHashes);

  // Lists available export tables with their persisted hash and timestamp.
  app.get('/api/export', async () =>
    Object.entries(EXPORT_TABLES).map(([slug, { label }]) => {
      const entry = exportState.get(slug);
      return { slug, label, hash: entry?.hash ?? null, exportedAt: entry?.exportedAt ?? null };
    }),
  );

  // Triggers a server-side hash refresh for all tables and returns the updated list.
  // Rate-limited aggressively since each call fetches all tables from Teable.
  app.post(
    '/api/export/refresh',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (_req, reply) => {
      if (!config.teable.token) {
        return reply.code(503).send({ error: 'Export unavailable' });
      }
      await refreshHashes();
      return Object.entries(EXPORT_TABLES).map(([slug, { label }]) => {
        const entry = exportState.get(slug);
        return { slug, label, hash: entry?.hash ?? null, exportedAt: entry?.exportedAt ?? null };
      });
    },
  );

  // Fetches a CSV from Teable, updates the cached hash, and sends it to the client.
  async function serveExportCsv(
    table: string,
    entry: { label: string; tableName: string },
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    if (!config.teable.token) {
      return reply.code(503).send({ error: 'Export unavailable' });
    }

    const exportUrl = `${config.teable.baseUrl}/api/export/${await resolveTableId(entry.tableName)}`;
    let upstream: Response;
    try {
      upstream = await fetch(exportUrl, {
        headers: { Authorization: `Bearer ${config.teable.token}` },
      });
    } catch {
      req.log.warn({ table }, 'could not reach Teable for export');
      return reply.code(502).send({ error: 'Could not reach the database. Please try again.' });
    }

    if (!upstream.ok || !upstream.body) {
      req.log.warn({ table, status: upstream.status }, 'Teable export failed');
      return reply.code(502).send({ error: 'Export unavailable. Please try again later.' });
    }

    const bytes = await upstream.arrayBuffer();
    const buf = Buffer.from(bytes);
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 8);
    const exportedAt = new Date().toISOString();
    await saveState(table, { hash, exportedAt });

    const date = exportedAt.slice(0, 10);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${table}-${date}-${hash}.csv"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(buf);
  }

  // Redirects to the versioned URL so the filename is visible in the URL path.
  // Browsers save using the last path segment; fetch() clients can read response.url
  // to get the filename without needing Content-Disposition exposed via CORS.
  // Falls back to serving directly if no hash is cached yet (first boot).
  app.get<{ Params: { table: string } }>(
    '/api/export/:table',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const { table } = req.params;
      const entry = EXPORT_TABLES[table];
      if (!entry) return reply.code(404).send({ error: 'Unknown table' });

      const state = exportState.get(table);
      if (state) {
        const date = state.exportedAt.slice(0, 10);
        return reply.redirect(`/api/export/${table}/${table}-${date}-${state.hash}.csv`);
      }
      return serveExportCsv(table, entry, req, reply);
    },
  );

  // Actual download — :filename is purely a hint for the browser's save dialog.
  app.get<{ Params: { table: string; filename: string } }>(
    '/api/export/:table/:filename',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const { table } = req.params;
      const entry = EXPORT_TABLES[table];
      if (!entry) return reply.code(404).send({ error: 'Unknown table' });
      return serveExportCsv(table, entry, req, reply);
    },
  );
}
