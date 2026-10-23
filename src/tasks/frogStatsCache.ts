import { schedule as cronSchedule } from 'node-cron';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { errorMessage, notifyPollerFailure } from '../notify';
import { authHeader, resolveFieldId, resolveTableId } from '../teable';

// Home page frog summary — the total frog count and the highest Value, with
// every frog tied at it. Counting the 40k+ row Froggies table and sorting it by
// Value is slow, so the worker does it once a day (and at startup) and serves
// the result from memory; site visitors only ever read the cached copy.

export interface FrogStats {
  count: number;
  maxValue: number | null;
  topFrogs: { id: string; frogId: string; fullname: string }[]; // every frog tied at maxValue
  updatedAt: string;
}

// How many top-sorted records to scan for ties at the max value. The highest
// value is realistically held by only a handful of frogs, so this cap is never
// approached, but it bounds the single request.
const TOP_TIE_CAP = 50;

let cached: FrogStats | null = null;
let inFlight: Promise<FrogStats> | null = null;

async function computeFrogStats(): Promise<FrogStats> {
  const tableId = await resolveTableId('Froggies');
  const valueField = await resolveFieldId(tableId, { dbFieldName: 'Value' });
  const base = `${config.teable.baseUrl}/api/table/${tableId}`;
  const orderBy = encodeURIComponent(JSON.stringify([{ fieldId: valueField, order: 'desc' }]));

  const [countRes, topRes] = await Promise.all([
    fetch(`${base}/aggregation/row-count`, { headers: authHeader() }),
    fetch(`${base}/record?fieldKeyType=dbFieldName&take=${TOP_TIE_CAP}&orderBy=${orderBy}`, { headers: authHeader() }),
  ]);
  if (!countRes.ok) throw new Error(`Frog count failed (${countRes.status})`);
  if (!topRes.ok) throw new Error(`Frog top-value fetch failed (${topRes.status})`);

  const countData = (await countRes.json()) as { rowCount?: number };
  const topData = (await topRes.json()) as {
    records?: { id: string; name?: string; fields: { Value?: unknown; fullname?: unknown; Frog_ID?: unknown } }[];
  };
  if (typeof countData.rowCount !== 'number') throw new Error('Frog count missing from response');

  const records = topData.records ?? [];
  const top = records[0]?.fields.Value;
  const maxValue = typeof top === 'number' ? top : null;
  const topFrogs = maxValue == null ? [] : records
    .filter(r => r.fields.Value === maxValue)
    .map(r => ({ id: r.id, frogId: String(r.fields.Frog_ID ?? r.name ?? ''), fullname: String(r.fields.fullname ?? r.name ?? '') }));

  return { count: countData.rowCount, maxValue, topFrogs, updatedAt: new Date().toISOString() };
}

// Recomputes the stats; concurrent callers share one Teable round trip. On
// failure the previous figures stay in place.
export function refreshFrogStats(): Promise<FrogStats> {
  if (!inFlight) {
    inFlight = computeFrogStats()
      .then(s => (cached = s))
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

// The cached stats; only waits on Teable if nothing has loaded yet (e.g. the
// startup refresh failed or hasn't finished).
export async function getFrogStats(): Promise<FrogStats> {
  return cached ?? refreshFrogStats();
}

// Called after a stats submission is written: a Value that ties or beats the
// cached max changes the leaderboard, so refresh now instead of at the next run.
export function noteFrogValue(value: number, log?: FastifyInstance['log']): void {
  if (cached && (cached.maxValue == null || value >= cached.maxValue)) {
    refreshFrogStats().catch(err => log?.warn({ err: errorMessage(err) }, 'frog stats: refresh after submission failed'));
  }
}

async function runRefresh(log: FastifyInstance['log']): Promise<void> {
  try {
    const s = await refreshFrogStats();
    log.info({ count: s.count, maxValue: s.maxValue, holders: s.topFrogs.length }, 'frog stats: refreshed');
  } catch (err) {
    log.error({ err: errorMessage(err) }, 'frog stats: refresh failed');
    notifyPollerFailure('Frog stats', [errorMessage(err)]);
  }
}

export function registerFrogStatsCache(log: FastifyInstance['log']): void {
  void runRefresh(log);
  cronSchedule(config.frogStats.refreshCron, () => runRefresh(log));
  log.info(`Frog stats cache scheduled — cron=${config.frogStats.refreshCron}`);
}
