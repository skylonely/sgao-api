import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { accessIdentity, accountId, type IdentityResolver } from './account';

type AppEnv = { Bindings: Env };
type Note = {
  id: string; title: string; content: string; pinned: boolean;
  createdAt: string; updatedAt: string; deletedAt: string | null; revision: number;
};
type Row = {
  note_id: string; title: string; content: string; pinned: number;
  created_at: string; updated_at: string; deleted_at: string | null; revision: number;
};
const ORIGIN = 'https://notes.sgao.cc';
const identifier = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const timestamp = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const columns = 'note_id, title, content, pinned, created_at, updated_at, deleted_at, revision';
const document = (row: Row): Note => ({ id: row.note_id, title: row.title, content: row.content, pinned: !!row.pinned,
  createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, revision: row.revision });

export function parseNote(value: unknown): Note | undefined {
  if (!object(value) || Object.keys(value).some(k => !['id', 'title', 'content', 'pinned', 'createdAt', 'updatedAt', 'deletedAt', 'revision'].includes(k))
    || typeof value.id !== 'string' || !identifier.test(value.id)
    || typeof value.title !== 'string' || value.title.length > 200
    || typeof value.content !== 'string' || value.content.length > 100_000
    || typeof value.pinned !== 'boolean' || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
    || (value.deletedAt !== null && !timestamp(value.deletedAt))
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) return undefined;
  return value as Note;
}

export function createNotesApi(resolveIdentity: IdentityResolver = accessIdentity) {
  const api = new Hono<AppEnv>();
  api.use('*', bodyLimit({ maxSize: 512 * 1024,
    onError: c => c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Note exceeds 512 KiB' } }, 413) }));
  async function identity(c: Parameters<IdentityResolver>[0]) {
    const signedIn = await resolveIdentity(c);
    if (!signedIn?.email.trim()) return undefined;
    const email = signedIn.email.trim().toLowerCase();
    return { id: await accountId(email), email };
  }
  api.get('/', async c => {
    const account = await identity(c);
    if (!account) return c.json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in is required' } }, 401);
    const { results } = await c.env.CHECKLISTS_DB.prepare(
      `SELECT ${columns} FROM account_notes WHERE account_id = ? ORDER BY updated_at DESC, note_id`,
    ).bind(account.id).all<Row>();
    return c.json({ data: { account, notes: results.map(document) } });
  });
  api.post('/:id', async c => {
    const account = await identity(c);
    if (!account) return c.json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in is required' } }, 401);
    if (c.req.header('Origin') !== ORIGIN) return c.json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Notes writes require the notes-site origin' } }, 403);
    let payload: unknown;
    try { payload = await c.req.json(); }
    catch { return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400); }
    if (!object(payload) || Object.keys(payload).some(k => !['accountId', 'note'].includes(k)) || typeof payload.accountId !== 'string') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid payload' } }, 400);
    }
    if (payload.accountId !== account.id) return c.json({ error: { code: 'ACCOUNT_CHANGED', message: 'The signed-in account changed' } }, 409);
    const note = parseNote(payload.note);
    if (!note || note.id !== c.req.param('id')) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid note' } }, 400);
    const time = new Date().toISOString();
    // One compare-and-swap statement: no read/write race and no snapshot-wide overwrite.
    const saved = await c.env.CHECKLISTS_DB.prepare(`
      INSERT INTO account_notes (account_id, note_id, title, content, pinned, created_at, updated_at, deleted_at, revision)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1
      WHERE ?9 = 0 OR EXISTS (SELECT 1 FROM account_notes WHERE account_id = ?1 AND note_id = ?2 AND revision = ?9)
      ON CONFLICT(account_id, note_id) DO UPDATE SET title = excluded.title, content = excluded.content,
        pinned = excluded.pinned, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
        revision = account_notes.revision + 1
      WHERE account_notes.revision = ?9
      RETURNING ${columns}
    `).bind(account.id, note.id, note.title, note.content, note.pinned ? 1 : 0,
      new Date(note.createdAt).toISOString(), time, note.deletedAt ? new Date(note.deletedAt).toISOString() : null, note.revision).first<Row>();
    if (!saved) {
      const current = await c.env.CHECKLISTS_DB.prepare(`SELECT ${columns} FROM account_notes WHERE account_id = ? AND note_id = ?`)
        .bind(account.id, note.id).first<Row>();
      return c.json({ error: { code: 'SYNC_CONFLICT', message: 'Note changed on another device' }, data: { note: current ? document(current) : null } }, 409);
    }
    return c.json({ data: { note: document(saved) } });
  });
  return api;
}
