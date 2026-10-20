import pg from 'pg';
import { config } from './config';

export type Status = 'pending' | 'rejected' | 'pushed' | 'error';

export interface SubmissionRow {
  id: string;
  type: string;
  payload: string; // JSON
  status: Status;
  summary: string;
  screenshot: string | null; // object key in the screenshots bucket
  screenshot_original: string | null; // uncropped upload, kept while an auto-cropped row is pending
  submitter_note: string | null;
  submitter_sub: string | null;  // Zitadel user id, if the submitter was signed in
  submitter_name: string | null; // their display name at submission time
  reviewer_note: string | null;
  source_ip: string | null; // hashed
  created_at: string; // ISO
  reviewed_at: string | null;
  pushed_ref: string | null; // Teable record id after a successful push
  batch_id: string | null; // shared by every row from one batch submit
}

// The connection goes through the node's HAProxy, which drops every session
// when the primary moves. An idle client erroring out then is expected; the
// pool replaces it on the next query.
export const pool = new pg.Pool({ connectionString: config.databaseUrl });
pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.warn('postgres idle client error:', err.message);
});

type Params = unknown[];

export async function many<T>(sql: string, params: Params = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}

export async function one<T>(sql: string, params: Params = []): Promise<T | undefined> {
  return (await pool.query(sql, params)).rows[0] as T | undefined;
}

// Runs a write and returns how many rows it touched.
export async function run(sql: string, params: Params = []): Promise<number> {
  return (await pool.query(sql, params)).rowCount ?? 0;
}

// Runs fn inside one transaction on a single connection.
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { /* connection already gone */ });
    throw e;
  } finally {
    client.release();
  }
}

// Every table the worker owns. Timestamps stay ISO text, as the API returns them.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS submissions (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL,
    payload             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending',
    summary             TEXT NOT NULL,
    screenshot          TEXT,
    screenshot_original TEXT,
    submitter_note      TEXT,
    submitter_sub       TEXT,
    submitter_name      TEXT,
    reviewer_note       TEXT,
    source_ip           TEXT,
    created_at          TEXT NOT NULL,
    reviewed_at         TEXT,
    pushed_ref          TEXT,
    batch_id            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_submissions_submitter ON submissions(submitter_sub, created_at);

  CREATE TABLE IF NOT EXISTS users (
    sub                TEXT PRIMARY KEY,
    username           TEXT,
    flair              TEXT,
    flair_pending      TEXT,
    flair_status       TEXT,
    flair_passphrase   TEXT,
    flair_sender_code  TEXT,
    flair_requested_at TEXT,
    connected_accounts TEXT,
    display_source     TEXT,
    show_credit        INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL,
    last_seen          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS badges (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    icon        TEXT,
    color       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_badges (
    sub        TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
    badge_id   TEXT NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
    granted_at TEXT NOT NULL,
    granted_by TEXT,
    PRIMARY KEY (sub, badge_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_badges_sub ON user_badges(sub);

  CREATE TABLE IF NOT EXISTS user_weekly_completions (
    sub           TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
    weekly_set_id TEXT NOT NULL,
    completed_at  TEXT NOT NULL,
    PRIMARY KEY (sub, weekly_set_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_weekly_completions_sub ON user_weekly_completions(sub);

  -- Color Wheel presets saved from the site (see wheelPresets.ts). habitats is
  -- JSON: up to three lists of "Base_Color_ID:Sec_Color_ID" codes.
  CREATE TABLE IF NOT EXISTS user_wheel_presets (
    id         TEXT PRIMARY KEY,
    sub        TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    habitats   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wheel_presets_name ON user_wheel_presets(sub, lower(name));

  CREATE TABLE IF NOT EXISTS alerts (
    id         TEXT PRIMARY KEY,
    message    TEXT NOT NULL,
    level      TEXT NOT NULL DEFAULT 'info',
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(active, created_at);

  CREATE TABLE IF NOT EXISTS export_state (
    slug        TEXT PRIMARY KEY,
    hash        TEXT NOT NULL,
    exported_at TEXT NOT NULL
  );

  -- In-flight account-linking attempts (see routes/links.ts). nonce_hash ties
  -- the callback to the browser that started it.
  CREATE TABLE IF NOT EXISTS link_intents (
    id         TEXT PRIMARY KEY,
    sub        TEXT NOT NULL,
    idp_id     TEXT NOT NULL,
    nonce_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  );
`;

// Creates any missing tables. Run once at startup, before serving.
export async function migrate(): Promise<void> {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set.');
  await pool.query(SCHEMA);
}

const COLS = `id, type, payload, summary, screenshot, screenshot_original, submitter_note,
  submitter_sub, submitter_name, source_ip, created_at, batch_id`;

export interface NewSubmission {
  id: string;
  type: string;
  payload: string;
  summary: string;
  screenshot: string | null;
  screenshot_original: string | null;
  submitter_note: string | null;
  submitter_sub: string | null;
  submitter_name: string | null;
  source_ip: string | null;
  created_at: string;
  batch_id: string | null;
}

function insertParams(r: NewSubmission): unknown[] {
  return [
    r.id, r.type, r.payload, r.summary, r.screenshot, r.screenshot_original, r.submitter_note,
    r.submitter_sub, r.submitter_name, r.source_ip, r.created_at, r.batch_id,
  ];
}

const INSERT = `INSERT INTO submissions (${COLS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;

export async function insertSubmission(row: NewSubmission): Promise<void> {
  await run(INSERT, insertParams(row));
}

// Inserts every row of a batch, or none of them.
export async function insertSubmissions(rows: NewSubmission[]): Promise<void> {
  await transaction(async (client) => {
    for (const r of rows) await client.query(INSERT, insertParams(r));
  });
}

export function getById(id: string): Promise<SubmissionRow | undefined> {
  return one<SubmissionRow>(`SELECT * FROM submissions WHERE id = $1`, [id]);
}

export function listByStatus(status: Status): Promise<SubmissionRow[]> {
  return many<SubmissionRow>(`SELECT * FROM submissions WHERE status = $1 ORDER BY created_at DESC`, [status]);
}

export function listPendingInBatch(batchId: string): Promise<SubmissionRow[]> {
  return many<SubmissionRow>(
    `SELECT * FROM submissions WHERE batch_id = $1 AND status = 'pending' ORDER BY summary`, [batchId],
  );
}

export function listBySubmitter(sub: string): Promise<SubmissionRow[]> {
  return many<SubmissionRow>(`SELECT * FROM submissions WHERE submitter_sub = $1 ORDER BY created_at DESC`, [sub]);
}

export async function setStatus(r: {
  id: string; status: Status; reviewer_note: string | null; reviewed_at: string; pushed_ref: string | null;
}): Promise<void> {
  await run(
    `UPDATE submissions
        SET status = $2, reviewer_note = $3, reviewed_at = $4, pushed_ref = $5,
            screenshot_original = CASE WHEN $2 = 'pending' THEN screenshot_original END
      WHERE id = $1`,
    [r.id, r.status, r.reviewer_note, r.reviewed_at, r.pushed_ref],
  );
}

// Rewrites a pending submission's payload and screenshots.
export async function updatePending(r: {
  id: string; payload: string; summary: string; screenshot: string | null; screenshot_original: string | null;
}): Promise<void> {
  await run(
    `UPDATE submissions
        SET payload = $2, summary = $3, screenshot = $4, screenshot_original = $5
      WHERE id = $1 AND status = 'pending'`,
    [r.id, r.payload, r.summary, r.screenshot, r.screenshot_original],
  );
}

// The review list's source link mirrors the payload's sourceLink, as on submit.
export async function setSubmitterNote(id: string, note: string | null): Promise<void> {
  await run(`UPDATE submissions SET submitter_note = $2 WHERE id = $1 AND status = 'pending'`, [id, note]);
}

// Reassigns (or, with nulls, anonymises) a pending submission's credit.
export async function setSubmitter(id: string, sub: string | null, name: string | null): Promise<void> {
  await run(
    `UPDATE submissions SET submitter_sub = $2, submitter_name = $3 WHERE id = $1 AND status = 'pending'`,
    [id, sub, name],
  );
}

export async function deleteById(id: string): Promise<void> {
  await run(`DELETE FROM submissions WHERE id = $1`, [id]);
}

// Distinct values of one payload key across a type's pending submissions — e.g.
// the frog ids that already have a stats submission awaiting review.
export async function pendingPayloadValues(type: string, key: string): Promise<string[]> {
  const rows = await many<{ v: string | null }>(
    `SELECT DISTINCT payload::jsonb ->> $2 AS v FROM submissions WHERE type = $1 AND status = 'pending'`,
    [type, key],
  );
  return rows.map(r => r.v).filter((v): v is string => typeof v === 'string');
}

// Like pendingPayloadValues, for two keys read together — e.g. the parent pairs
// (frog1Id, frog2Id) that have a combo awaiting review.
export async function pendingPayloadPairs(type: string, keyA: string, keyB: string): Promise<[string, string][]> {
  const rows = await many<{ a: string | null; b: string | null }>(
    `SELECT DISTINCT payload::jsonb ->> $2 AS a, payload::jsonb ->> $3 AS b
       FROM submissions WHERE type = $1 AND status = 'pending'`,
    [type, keyA, keyB],
  );
  return rows
    .filter((r): r is { a: string; b: string } => typeof r.a === 'string' && typeof r.b === 'string')
    .map(r => [r.a, r.b]);
}
