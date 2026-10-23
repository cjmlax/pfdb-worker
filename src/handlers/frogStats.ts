import { z } from 'zod';
import type { SubmissionHandler } from '../types';
import { pendingPayloadValues } from '../db';
import { resolveFieldId, resolveTableId, teableGetRecordById, teableUpdateRecordById } from '../teable';
import { noteFrogValue } from '../tasks/frogStatsCache';
import { noteDailyFrogUpdated } from '../tasks/dailyFrog';

// Community-submitted Value / Speed / Stamina for a frog that's missing them.
// Only fills gaps: corrections to existing stats aren't accepted (yet), so a
// submitted stat that disagrees with one already in the database is refused.
//
// The website sends all three stats — for a frog that's only partly missing,
// the already-known stats are passed through unchanged. Numeric strings are
// accepted so the admin edit form (which round-trips everything as strings)
// still works — but a blank stays blank rather than coercing to 0.
const stat = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/[,\s]/g, '')) : v),
  z.number().int().min(0).max(1e12),
);

export const frogStatsSchema = z.object({
  frogId: z.string().min(1).max(40),
  frogName: z.string().min(1).max(120),
  value: stat,
  speed: stat,
  stamina: stat,
});

export type FrogStatsPayload = z.infer<typeof frogStatsSchema>;

const STATS = [
  { key: 'value',   label: 'Value',   dbFieldName: 'Value' },
  { key: 'speed',   label: 'Speed',   dbFieldName: 'Speed' },
  { key: 'stamina', label: 'Stamina', dbFieldName: 'Stamina' },
] as const;

const fmt = (n: unknown) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));

// Compares the submission against the frog's current record. Returns the
// fields that still need filling, or throws if the frog is gone, already
// complete, or a submitted stat contradicts a recorded one.
async function planUpdate(p: FrogStatsPayload): Promise<{ tableId: string; fields: Record<string, number> }> {
  const tableId = await resolveTableId('Froggies');
  const current = await teableGetRecordById(tableId, p.frogId);
  if (!current) throw new Error(`${p.frogName} is not a known frog.`);

  const fields: Record<string, number> = {};
  for (const s of STATS) {
    const fieldId = await resolveFieldId(tableId, { dbFieldName: s.dbFieldName });
    const existing = current[fieldId];
    const submitted = p[s.key];
    if (existing === null || existing === undefined || existing === '') {
      fields[fieldId] = submitted;
    } else if (Number(existing) !== submitted) {
      throw new Error(
        `${p.frogName} already has ${s.label} ${fmt(existing)} (submitted ${fmt(submitted)}) — corrections aren't accepted yet.`,
      );
    }
  }
  if (Object.keys(fields).length === 0) throw new Error(`${p.frogName} already has all of its stats.`);
  return { tableId, fields };
}

export const frogStatsHandler: SubmissionHandler<FrogStatsPayload> = {
  type: 'frogStats',
  label: 'Frog stats',
  schema: frogStatsSchema,
  async preSubmit(p) {
    if ((await pendingPayloadValues('frogStats', 'frogId')).includes(p.frogId)) {
      throw new Error(`${p.frogName} already has a submission pending review.`);
    }
    await planUpdate(p);
  },
  dedupeKey: (p) => p.frogId,
  summarize: (p) =>
    `${p.frogName} — Value ${fmt(p.value)} · Speed ${fmt(p.speed)} · Stamina ${fmt(p.stamina)}`,
  async pushDown(raw) {
    // Re-validate: an admin edit stores the payload as strings without parsing.
    const p = frogStatsSchema.parse(raw);
    const { tableId, fields } = await planUpdate(p);
    await teableUpdateRecordById(tableId, p.frogId, fields);
    // The home page's highest Value and Frog of the Day update right away.
    noteFrogValue(p.value);
    noteDailyFrogUpdated(p.frogId);
    return p.frogId;
  },
};
