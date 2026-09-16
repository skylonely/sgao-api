import { env, createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import worker from '../src/index';
import { accountId, createAccountApi } from '../src/account';
import { createNavigationApi, parseNavigationData } from '../src/navigation';

const EMPTY = { favorites: [], customSites: [], customNavigations: [] };
const NAVIGATION = {
  favorites: ['github', 'custom-work'],
  customNavigations: [{ id: 'custom-nav-work', name: '工作', icon: '◇', eyebrow: 'MY NAVIGATION', isCustom: true }],
  customSites: [{ id: 'custom-work', name: '我的工具', url: 'https://example.com/', desc: '工作入口', category: 'custom-nav-work', tags: ['自定义'], isCustom: true }],
};

describe('account navigation API', () => {
  beforeEach(async () => {
    await env.CHECKLISTS_DB.prepare(`CREATE TABLE IF NOT EXISTS account_navigation_profiles (
      account_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).run();
    await env.CHECKLISTS_DB.prepare('DELETE FROM account_navigation_profiles').run();
  });

  async function call(email: string | undefined, method = 'GET', payload?: unknown, origin = 'https://sgao.cc') {
    const api = createNavigationApi(async () => email ? { email } : undefined);
    return api.fetch(new Request('https://api.sgao.cc/', {
      method, headers: { Origin: origin, 'Content-Type': 'text/plain;charset=UTF-8' },
      ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
    }), env, createExecutionContext());
  }

  it('requires trusted identity, not a caller-provided account ID', async () => {
    expect((await call(undefined)).status).toBe(401);
    expect((await call(undefined, 'POST', {})).status).toBe(401);
    const id = await accountId('owner@sgao.cc');
    expect((await call('other@sgao.cc', 'POST', { accountId: id, revision: 0, navigation: NAVIGATION })).status).toBe(409);
    expect(await env.CHECKLISTS_DB.prepare('SELECT COUNT(*) AS count FROM account_navigation_profiles').first('count')).toBe(0);
  });

  it('initializes, saves and restores navigation with independent revisions', async () => {
    const id = await accountId('owner@sgao.cc');
    const initial = await call('Owner@SGAO.cc');
    expect(await initial.json()).toMatchObject({ data: { account: { id, email: 'owner@sgao.cc' }, initialized: false, revision: 0, navigation: EMPTY } });
    const saved = await call('owner@sgao.cc', 'POST', { accountId: id, revision: 0, navigation: NAVIGATION });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ data: { initialized: true, revision: 1, navigation: NAVIGATION } });
    expect(await (await call('owner@sgao.cc')).json()).toMatchObject({ data: { revision: 1, navigation: NAVIGATION } });
    expect(await (await call('other@sgao.cc')).json()).toMatchObject({ data: { initialized: false, navigation: EMPTY } });
    const stale = await call('owner@sgao.cc', 'POST', { accountId: id, revision: 0, navigation: EMPTY });
    expect(stale.status).toBe(409);
    expect(await (await call('owner@sgao.cc')).json()).toMatchObject({ data: { revision: 1, navigation: NAVIGATION } });
    expect((await call('owner@sgao.cc', 'POST', { accountId: id, revision: 1, navigation: EMPTY })).status).toBe(200);
    expect(await (await call('owner@sgao.cc')).json()).toMatchObject({ data: { initialized: true, revision: 2, navigation: EMPTY } });
  });

  it('does not create an account snapshot for a nonzero initial revision', async () => {
    expect((await call('owner@sgao.cc', 'POST', { accountId: await accountId('owner@sgao.cc'), revision: 5, navigation: EMPTY })).status).toBe(409);
    expect(await (await call('owner@sgao.cc')).json()).toMatchObject({ data: { initialized: false, revision: 0 } });
  });

  it('leaves Todo tables untouched', async () => {
    await env.CHECKLISTS_DB.prepare('CREATE TABLE IF NOT EXISTS account_profiles (account_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0)').run();
    const id = await accountId('owner@sgao.cc');
    await env.CHECKLISTS_DB.prepare('INSERT OR REPLACE INTO account_profiles (account_id, revision) VALUES (?, ?)').bind(id, 37).run();
    expect((await call('owner@sgao.cc', 'POST', { accountId: id, revision: 0, navigation: NAVIGATION })).status).toBe(200);
    expect(await env.CHECKLISTS_DB.prepare('SELECT revision FROM account_profiles WHERE account_id = ?').bind(id).first('revision')).toBe(37);
  });

  it('rejects private history, invalid links, duplicate IDs and missing categories', async () => {
    const id = await accountId('owner@sgao.cc');
    const invalid = [
      { ...NAVIGATION, history: ['github'] },
      { ...NAVIGATION, customSites: [{ ...NAVIGATION.customSites[0], url: 'javascript:alert(1)' }] },
      { ...NAVIGATION, customSites: [{ ...NAVIGATION.customSites[0], url: 'https://user:password@example.com/' }] },
      { ...NAVIGATION, customSites: [...NAVIGATION.customSites, ...NAVIGATION.customSites] },
      { ...NAVIGATION, customSites: [{ ...NAVIGATION.customSites[0], category: 'missing' }] },
      { ...NAVIGATION, favorites: ['bad id'] },
    ];
    for (const navigation of invalid) expect((await call('owner@sgao.cc', 'POST', { accountId: id, revision: 0, navigation })).status).toBe(400);
    expect((await call('owner@sgao.cc', 'POST', { accountId: id, revision: 0, navigation: NAVIGATION, history: ['github'] })).status).toBe(400);
    expect((await call('owner@sgao.cc', 'POST', { accountId: id, revision: 0, navigation: NAVIGATION }, 'https://evil.example')).status).toBe(403);
    expect(await (await call('owner@sgao.cc')).json()).toMatchObject({ data: { initialized: false } });
  });

  it('enforces request-size limits before writing', async () => {
    const oversized = await call('owner@sgao.cc', 'POST', { accountId: await accountId('owner@sgao.cc'), revision: 0, navigation: NAVIGATION, padding: 'x'.repeat(512 * 1024) });
    expect(oversized.status).toBe(413);
  });

  it('normalizes legacy categories and strips unknown site fields', () => {
    expect(parseNavigationData({ ...NAVIGATION, customSites: [{ ...NAVIGATION.customSites[0], category: 'music', history: ['private'] }] }))
      .toEqual({ ...NAVIGATION, customSites: [{ ...NAVIGATION.customSites[0], category: 'tools' }] });
  });

  it('allows only exact trusted account CORS origins', async () => {
    for (const origin of ['https://sgao.cc', 'https://todo.sgao.cc', 'https://evil.sgao.cc', 'https://sgao.cc.evil.example', 'http://sgao.cc', 'null']) {
      const response = await worker.fetch(new Request('https://api.sgao.cc/api/v1/account/navigation', {
        method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      }), env, createExecutionContext());
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(['https://sgao.cc', 'https://todo.sgao.cc'].includes(origin) ? origin : null);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
  });

  it('mounts the navigation endpoint at the exact frontend URL', async () => {
    const response = await worker.fetch(new Request('https://api.sgao.cc/api/v1/account/navigation'), env, createExecutionContext());
    expect(response.status).toBe(401);
  });

  it('redirects login only to the main site and Todo', async () => {
    const api = createAccountApi(async () => ({ email: 'owner@sgao.cc' }));
    for (const target of ['https://sgao.cc/?view=favorites', 'https://todo.sgao.cc/travel']) {
      const response = await api.fetch(new Request('https://api.sgao.cc/login?returnTo=' + encodeURIComponent(target)), env, createExecutionContext());
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe(target);
    }
    for (const target of ['https://evil.example', 'https://sgao.cc.evil.example', 'https://user:pass@sgao.cc/', 'http://sgao.cc/']) {
      const response = await api.fetch(new Request('https://api.sgao.cc/login?returnTo=' + encodeURIComponent(target)), env, createExecutionContext());
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    }
  });
});
