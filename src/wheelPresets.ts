import { randomUUID } from 'node:crypto';
import { many, one, run } from './db';

// Color Wheel presets a signed-in user saves from the site's Color Wheels page.
// A preset is breed-independent, like the site's built-in ones: up to three
// habitats of "Base_Color_ID:Sec_Color_ID" codes, one frog per base color, so
// it can be dropped onto any breed. Tables are created in db.ts.

export const MAX_PRESETS = 50;
export const MAX_NAME = 32;
const HABITATS = 3;
const HABITAT_SIZE = 8;

export type Habitats = string[][];

export interface WheelPreset {
  id: string;
  name: string;
  habitats: Habitats;
  updatedAt: string;
}

interface PresetRow { id: string; name: string; habitats: string; updated_at: string }

const toPreset = (r: PresetRow): WheelPreset =>
  ({ id: r.id, name: r.name, habitats: JSON.parse(r.habitats) as Habitats, updatedAt: r.updated_at });

// A trimmed name of 1–MAX_NAME characters, or null.
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name && name.length <= MAX_NAME ? name : null;
}

// Up to three habitats of up to eight color codes, at least one frog, and no
// base color twice; otherwise null.
export function cleanHabitats(value: unknown): Habitats | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > HABITATS) return null;
  const bases = new Set<string>();
  const habitats: Habitats = [];
  for (const h of value) {
    if (!Array.isArray(h) || h.length > HABITAT_SIZE) return null;
    for (const code of h) {
      if (typeof code !== 'string' || !/^\d{1,6}:\d{1,6}$/.test(code)) return null;
      const base = code.split(':')[0];
      if (bases.has(base)) return null;
      bases.add(base);
    }
    habitats.push([...h]);
  }
  return bases.size > 0 ? habitats : null;
}

export async function listWheelPresets(sub: string): Promise<WheelPreset[]> {
  const rows = await many<PresetRow>(
    `SELECT id, name, habitats, updated_at FROM user_wheel_presets WHERE sub = $1 ORDER BY lower(name)`, [sub],
  );
  return rows.map(toPreset);
}

export type SaveResult = 'ok' | 'limit' | 'duplicate' | 'missing';

export async function createWheelPreset(sub: string, name: string, habitats: Habitats): Promise<SaveResult> {
  const count = await one<{ n: string }>(`SELECT count(*) AS n FROM user_wheel_presets WHERE sub = $1`, [sub]);
  if (Number(count?.n ?? 0) >= MAX_PRESETS) return 'limit';
  const now = new Date().toISOString();
  const inserted = await run(
    `INSERT INTO user_wheel_presets (id, sub, name, habitats, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (sub, lower(name)) DO NOTHING`,
    [randomUUID(), sub, name, JSON.stringify(habitats), now],
  );
  return inserted ? 'ok' : 'duplicate';
}

// Overwrites a preset's frogs; its name stays.
export async function overwriteWheelPreset(sub: string, id: string, habitats: Habitats): Promise<SaveResult> {
  const updated = await run(
    `UPDATE user_wheel_presets SET habitats = $3, updated_at = $4 WHERE sub = $1 AND id = $2`,
    [sub, id, JSON.stringify(habitats), new Date().toISOString()],
  );
  return updated ? 'ok' : 'missing';
}

export async function deleteWheelPreset(sub: string, id: string): Promise<void> {
  await run(`DELETE FROM user_wheel_presets WHERE sub = $1 AND id = $2`, [sub, id]);
}
