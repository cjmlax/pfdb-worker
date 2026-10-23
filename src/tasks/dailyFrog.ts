import { schedule as cronSchedule } from 'node-cron';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { errorMessage, notifyPollerFailure } from '../notify';
import { authHeader, resolveFieldId, resolveTableId } from '../teable';

// PFDB Frog of the Day. The pick is a pure function of the date and the
// Breeds / Base Colors / Secondary Colors tables, so the worker computes it once
// per date and every visitor reads the same cached answer. (It used to run in
// each browser, which also needed four tables and a frog search per visit.)
//
// Dates are YYYY-MM-DD. The site asks for the date it wants; only yesterday,
// today and tomorrow (in UTC) are accepted, which covers every time zone's
// current calendar day — so the site can follow UTC or the visitor's local day.

export interface DailyFrog {
  date:    string;
  name:    string; // "Base Sec Breed"
  baseId:  string; // record ids, for rendering the frog
  secId:   string;
  breedId: string;
  level:   number | null;
  frog: { id: string; frogId: string; value: number | null; speed: number | null; stamina: number | null } | null;
}

type Rec = { id: string; fields: Record<string, unknown> };

// All records in their default order, keyed by dbFieldName — the same request
// shape the website makes, so indexes into these lists match what it saw.
async function listByDbName(tableName: string, filter?: object): Promise<Rec[]> {
  const tableId = await resolveTableId(tableName);
  const out: Rec[] = [];
  const take = 1000;
  for (let skip = 0; ; skip += take) {
    const q = new URLSearchParams({ fieldKeyType: 'dbFieldName', take: String(take), skip: String(skip) });
    if (filter) q.set('filter', JSON.stringify(filter));
    const res = await fetch(`${config.teable.baseUrl}/api/table/${tableId}/record?${q}`, { headers: authHeader() });
    if (!res.ok) throw new Error(`${tableName} fetch failed (${res.status})`);
    const records = ((await res.json()) as { records?: { id: string; fields?: Record<string, unknown> }[] }).records ?? [];
    for (const r of records) out.push({ id: r.id, fields: r.fields ?? {} });
    if (records.length < take) return out;
  }
}

function linkId(val: unknown): string | null {
  const first = Array.isArray(val) ? val[0] : val;
  return first && typeof first === 'object' && 'id' in first ? String((first as { id: unknown }).id) : null;
}

const num = (v: unknown) => (typeof v === 'number' ? v : null);

// The original formula: seed YYYYDDMM, one sin() multiplier per pick.
function seedFor(date: string): number {
  const [y, m, d] = date.split('-');
  return parseInt(y + d + m, 10);
}
const pick = <T>(list: T[], seed: number, mult: number): T =>
  list[Math.floor(Math.abs((Math.sin(seed) * mult) % 1) * list.length)];

async function computeDailyFrog(date: string): Promise<DailyFrog> {
  const [breeds, bases, secs, levels] = await Promise.all([
    listByDbName('Breeds'), listByDbName('Base Colors'), listByDbName('Secondary Colors'), listByDbName('Levels'),
  ]);
  if (!breeds.length || !bases.length || !secs.length) throw new Error('lookup tables are empty');

  const x = seedFor(date);
  const base = pick(bases, x, 10915);
  const sec = pick(secs, x, 81293);
  const breed = pick(breeds, x, 23917);

  // Normally exactly one frog per combination; pick among them if not.
  const frogsId = await resolveTableId('Froggies');
  const [fBase, fSec, fBreed] = await Promise.all(
    ['Primary', 'Secondary', 'Breed'].map(dbFieldName => resolveFieldId(frogsId, { dbFieldName })),
  );
  const frogs = await listByDbName('Froggies', {
    conjunction: 'and',
    filterSet: [
      { fieldId: fBase, operator: 'is', value: base.id },
      { fieldId: fSec, operator: 'is', value: sec.id },
      { fieldId: fBreed, operator: 'is', value: breed.id },
    ],
  });
  const frog = frogs.length ? pick(frogs, x, 57293) : null;

  const levelRec = levels.find(l => l.id === linkId(breed.fields.Level));
  return {
    date,
    name: `${base.fields.BaseColors ?? '?'} ${sec.fields.Sec_Color ?? '?'} ${breed.fields.Breed ?? '?'}`,
    baseId: base.id,
    secId: sec.id,
    breedId: breed.id,
    level: num(levelRec?.fields.Level_No),
    frog: frog && {
      id: frog.id,
      frogId: String(frog.fields.Frog_ID ?? ''),
      value: num(frog.fields.Value),
      speed: num(frog.fields.Speed),
      stamina: num(frog.fields.Stamina),
    },
  };
}

// ── Date window ──────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Yesterday, today and tomorrow in UTC.
function liveDates(): string[] {
  const now = Date.now();
  return [utcDate(now - DAY_MS), utcDate(now), utcDate(now + DAY_MS)];
}

export function isServableDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && liveDates().includes(date);
}

export function todayUtc(): string {
  return utcDate(Date.now());
}

// ── Cache ────────────────────────────────────────────────────────────────

const cache = new Map<string, Promise<DailyFrog>>();

function refresh(date: string): Promise<DailyFrog> {
  const prev = cache.get(date);
  const next = computeDailyFrog(date);
  cache.set(date, next);
  // On failure, fall back to the previous good answer if there was one.
  next.catch(() => {
    if (cache.get(date) === next) {
      if (prev) cache.set(date, prev); else cache.delete(date);
    }
  });
  return next;
}

// The cached pick for a date in the live window, computing it on first use.
export function getDailyFrog(date: string): Promise<DailyFrog> {
  return cache.get(date) ?? refresh(date);
}

// Recomputes the live window and forgets older dates. Run daily so tomorrow is
// ready before anyone reaches it, and so stats added since are picked up.
async function refreshWindow(log: FastifyInstance['log']): Promise<void> {
  const live = liveDates();
  for (const d of cache.keys()) if (!live.includes(d)) cache.delete(d);
  const results = await Promise.allSettled(live.map(refresh));
  const failures = results.flatMap((r, i) => (r.status === 'rejected' ? [`${live[i]}: ${errorMessage(r.reason)}`] : []));
  if (failures.length) {
    log.error({ failures }, 'daily frog: refresh failed');
    notifyPollerFailure('Frog of the Day', failures);
  } else {
    log.info({ dates: live }, 'daily frog: refreshed');
  }
}

// Called after a stats submission is written: if it's a cached daily frog,
// recompute that date so its new Value / Speed / Stamina show right away.
export function noteDailyFrogUpdated(frogRecordId: string, log?: FastifyInstance['log']): void {
  for (const [date, p] of cache) {
    p.then(d => {
      if (d.frog?.id === frogRecordId) {
        refresh(date).catch(err => log?.warn({ err: errorMessage(err), date }, 'daily frog: refresh after submission failed'));
      }
    }).catch(() => {});
  }
}

export function registerDailyFrog(log: FastifyInstance['log']): void {
  void refreshWindow(log);
  cronSchedule(config.frogStats.refreshCron, () => refreshWindow(log));
  log.info(`Daily frog cache scheduled — cron=${config.frogStats.refreshCron}`);
}
