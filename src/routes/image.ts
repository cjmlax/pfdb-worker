import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { authHeader, resolveTableId } from '../teable';

// Proxies Teable attachment images through this worker's own origin.
//
// Teable's attachment "presignedUrl" carries a short-lived signed token (a few
// minutes) that's baked into the SPA's IndexedDB table cache, which only
// re-fetches on a table's lastModifiedTime change — so cached image URLs go
// stale long before the underlying data does, and <img> requests start
// 400ing with "Token has expired". This endpoint gives the SPA a stable URL
// (table + record + field) that never expires; on every hit it re-fetches the
// single record (with the worker's Teable token) for a fresh
// presignedUrl and streams the bytes back same-origin.
// Each table's frontend fetcher uses a different fieldKeyType convention
// (fetchTable → dbFieldName, fetchMutations → display name), and the field param
// the SPA sends matches whichever one it reads locally — so this proxy must
// query Teable the same way per table, or the field key won't match.
// A field can hold several attachments (e.g. a Frog Pairs record keeps one
// screenshot per mutation); ?i=N picks one by position, defaulting to the first.
// ?name=<filename> picks one by exact file name instead (e.g. a breed's sprite
// layers), so reordering the files in Teable can't swap them; it wins over ?i.
const TABLE_CONFIG: Record<string, { name: string; fieldKeyType: 'dbFieldName' | 'name' }> = {
  breeds: { name: 'Breeds',               fieldKeyType: 'dbFieldName' },
  pairs:  { name: 'Frog Pairs',           fieldKeyType: 'name' },
};

interface AttachmentEntry {
  presignedUrl?: string;
  mimetype?: string;
  name?: string;
}

export async function registerImageRoutes(app: FastifyInstance) {
  app.get<{ Params: { table: string; recordId: string; field: string }; Querystring: { i?: string; name?: string } }>(
    '/api/image/:table/:recordId/:field',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { table, recordId, field } = req.params;
      const tableCfg = TABLE_CONFIG[table];
      if (!tableCfg) return reply.code(404).send({ error: 'unknown table' });
      const index = req.query.i === undefined ? 0 : Number(req.query.i);
      if (!Number.isInteger(index) || index < 0 || index > 50) {
        return reply.code(400).send({ error: 'invalid attachment index' });
      }
      const name = req.query.name;
      if (name !== undefined && (name.length === 0 || name.length > 200)) {
        return reply.code(400).send({ error: 'invalid attachment name' });
      }

      let tableId: string;
      try {
        tableId = await resolveTableId(tableCfg.name);
      } catch {
        return reply.code(502).send({ error: 'Could not reach the database. Please try again.' });
      }

      const recordUrl =
        `${config.teable.baseUrl}/api/table/${tableId}/record/${encodeURIComponent(recordId)}` +
        `?fieldKeyType=${tableCfg.fieldKeyType}`;
      let recordRes: Response;
      try {
        recordRes = await fetch(recordUrl, { headers: { Accept: 'application/json', ...authHeader() } });
      } catch {
        return reply.code(502).send({ error: 'Could not reach the database. Please try again.' });
      }
      if (recordRes.status === 404) return reply.code(404).send({ error: 'record not found' });
      if (!recordRes.ok) {
        req.log.warn({ table, recordId, status: recordRes.status }, 'image: Teable record lookup failed');
        return reply.code(502).send({ error: 'Database lookup failed.' });
      }

      const record = (await recordRes.json()) as { fields?: Record<string, unknown> };
      const fieldVal = record.fields?.[field];
      const entries = (Array.isArray(fieldVal) ? fieldVal : []) as AttachmentEntry[];
      const entry = name !== undefined ? entries.find(e => e?.name === name) : entries[index];
      if (!entry?.presignedUrl) return reply.code(404).send({ error: 'no attachment on this field' });

      let imgRes: Response;
      try {
        imgRes = await fetch(entry.presignedUrl);
      } catch {
        return reply.code(502).send({ error: 'Could not reach the database. Please try again.' });
      }
      if (!imgRes.ok || !imgRes.body) {
        req.log.warn({ table, recordId, status: imgRes.status, host: new URL(entry.presignedUrl).host }, 'image: attachment fetch failed');
        return reply.code(502).send({ error: 'Attachment fetch failed.' });
      }

      const buf = Buffer.from(await imgRes.arrayBuffer());
      reply.header('Content-Type', entry.mimetype ?? imgRes.headers.get('content-type') ?? 'application/octet-stream');
      reply.header('Content-Disposition', `inline${entry.name ? `; filename="${entry.name}"` : ''}`);
      // The proxy URL itself is stable (keyed by record+field+index), so browsers can
      // cache the bytes — the underlying attachment rarely changes after upload.
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(buf);
    },
  );
}
