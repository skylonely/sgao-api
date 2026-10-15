import { env, createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import worker from '../src/index';
import { accountId, createAccountApi } from '../src/account';
import { createNotesApi } from '../src/notes';

const ORIGIN = 'https://notes.sgao.cc';
const note = { id: 'note-one', title: '随手记', content: '第一行\n第二行 **内容**', pinned: false,
  createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z', deletedAt: null, revision: 0 };
describe('account notes', () => {
  beforeEach(async () => {
    await env.CHECKLISTS_DB.prepare(`CREATE TABLE IF NOT EXISTS account_notes (
      account_id TEXT NOT NULL, note_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      pinned INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      deleted_at TEXT, revision INTEGER NOT NULL, PRIMARY KEY(account_id, note_id))`).run();
    await env.CHECKLISTS_DB.prepare('DELETE FROM account_notes').run();
  });
  async function call(email: string | undefined = 'owner@sgao.cc', payload?: unknown, origin = ORIGIN, id = note.id) {
    const api = createNotesApi(async () => email ? { email } : undefined);
    return api.fetch(new Request('https://api.sgao.cc/' + (payload === undefined ? '' : id), {
      method: payload === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain;charset=UTF-8' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }), env, createExecutionContext());
  }
  const payload = async (next = note) => ({ accountId: await accountId('owner@sgao.cc'), note: next });
  it('requires a verified identity and rejects account spoofing', async () => {
    expect((await call('')).status).toBe(401);
    expect((await call('', await payload())).status).toBe(401);
    expect((await call('other@sgao.cc', await payload())).status).toBe(409);
    expect(await (await call()).json()).toMatchObject({ data: { notes: [] } });
  });
  it('creates, reads, edits, pins and synchronizes deletion', async () => {
    const saved = await call('owner@sgao.cc', await payload());
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ data: { note: { ...note, updatedAt: expect.any(String), revision: 1 } } });
    expect(await (await call()).json()).toMatchObject({ data: { notes: [{ content: note.content, revision: 1 }] } });
    const edited = { ...note, revision: 1, title: '修改', pinned: true };
    expect((await call('owner@sgao.cc', await payload(edited))).status).toBe(200);
    const deleted = { ...edited, revision: 2, deletedAt: '2026-10-15T12:00:00.000Z' } as typeof note;
    expect((await call('owner@sgao.cc', await payload(deleted))).status).toBe(200);
    expect(await (await call()).json()).toMatchObject({ data: { notes: [{ title: '修改', pinned: true, deletedAt: deleted.deletedAt, revision: 3 }] } });
  });
  it('returns the current note on stale revisions without overwriting content', async () => {
    await call('owner@sgao.cc', await payload());
    const stale = await call('owner@sgao.cc', await payload({ ...note, content: '过时修改' }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'SYNC_CONFLICT' }, data: { note: { content: note.content, revision: 1 } } });
    expect((await call('owner@sgao.cc', await payload({ ...note, id: 'missing', revision: 3 }), ORIGIN, 'missing')).status).toBe(409);
  });
  it('isolates accounts and per-note revisions', async () => {
    await call('owner@sgao.cc', await payload());
    expect(await (await call('other@sgao.cc')).json()).toMatchObject({ data: { notes: [] } });
    expect((await call('owner@sgao.cc', await payload({ ...note, id: 'note-two' }), ORIGIN, 'note-two')).status).toBe(200);
    expect(await (await call()).json()).toMatchObject({ data: { notes: expect.arrayContaining([{ ...note, updatedAt: expect.any(String), revision: 1 }]) } });
  });
  it('rejects foreign origins, invalid data and oversized bodies', async () => {
    for (const origin of ['https://sgao.cc', 'https://notes.sgao.cc.evil.example', 'null', '']) {
      expect((await call('owner@sgao.cc', await payload(), origin)).status).toBe(403);
    }
    for (const invalid of [{ ...note, content: 'x'.repeat(100_001) }, { ...note, revision: -1 },
      { ...note, title: 'x'.repeat(201) }, { ...note, createdAt: 'bad' }, { ...note, extra: 'private' }]) {
      expect((await call('owner@sgao.cc', { accountId: await accountId('owner@sgao.cc'), note: invalid })).status).toBe(400);
    }
    expect((await call('owner@sgao.cc', { accountId: await accountId('owner@sgao.cc'), note: { ...note, content: 'x'.repeat(600_000) } })).status).toBe(413);
  });
  it('mounts the endpoint, allows only the exact notes origin and redirects login back to notes', async () => {
    expect((await worker.fetch(new Request('https://api.sgao.cc/api/v1/account/notes'), env, createExecutionContext())).status).toBe(401);
    for (const origin of [ORIGIN, 'https://notes.sgao.cc.evil.example']) {
      const response = await worker.fetch(new Request('https://api.sgao.cc/api/v1/account/notes', {
        method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      }), env, createExecutionContext());
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin === ORIGIN ? ORIGIN : null);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
    const api = createAccountApi(async () => ({ email: 'owner@sgao.cc' }));
    const response = await api.fetch(new Request('https://api.sgao.cc/login?returnTo=' + encodeURIComponent(ORIGIN + '/')), env, createExecutionContext());
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(ORIGIN + '/');
  });
});
