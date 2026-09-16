import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { accessIdentity, accountId, type IdentityResolver } from './account';

type AppEnv = { Bindings: Env };
type CustomSite = {
  id: string; name: string; url: string; desc: string; category: string; tags: string[];
  mark?: string; badge?: string; isCustom: true;
};
type CustomNavigation = { id: string; name: string; icon: string; eyebrow: string; isCustom: true };
export type NavigationData = { favorites: string[]; customSites: CustomSite[]; customNavigations: CustomNavigation[] };
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const CATEGORIES = new Set(['all', 'featured', 'dev', 'design', 'tools', 'reading']);
const LEGACY_CATEGORIES = new Set(['anime', 'game', 'movie', 'music']);
const EMPTY = { favorites: [], customSites: [], customNavigations: [] };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

export function parseNavigationData(value: unknown): NavigationData | undefined {
  if (!object(value)
    || Object.keys(value).some((key) => !['favorites', 'customSites', 'customNavigations'].includes(key))
    || !Array.isArray(value.favorites) || value.favorites.length > 1000
    || !Array.isArray(value.customSites) || value.customSites.length > 500
    || !Array.isArray(value.customNavigations) || value.customNavigations.length > 100) return undefined;

  const navigationIds = new Set<string>();
  const customNavigations: CustomNavigation[] = [];
  for (const candidate of value.customNavigations) {
    if (!object(candidate) || !text(candidate.id, 80) || !candidate.id.startsWith('custom-nav-')
      || !IDENTIFIER.test(candidate.id) || navigationIds.has(candidate.id)
      || !text(candidate.name, 100) || !candidate.name.trim()
      || !text(candidate.icon, 8) || !text(candidate.eyebrow, 80)) return undefined;
    navigationIds.add(candidate.id);
    customNavigations.push({ id: candidate.id, name: candidate.name.trim(), icon: candidate.icon, eyebrow: candidate.eyebrow, isCustom: true });
  }

  const siteIds = new Set<string>();
  const customSites: CustomSite[] = [];
  for (const candidate of value.customSites) {
    if (!object(candidate) || !text(candidate.id, 80) || !candidate.id.startsWith('custom-')
      || !IDENTIFIER.test(candidate.id) || siteIds.has(candidate.id)
      || !text(candidate.name, 100) || !candidate.name.trim()
      || !text(candidate.url, 2048) || !text(candidate.desc, 500)
      || !text(candidate.category, 80)
      || !Array.isArray(candidate.tags) || candidate.tags.length > 20
      || !candidate.tags.every((tag) => text(tag, 80))
      || (candidate.mark !== undefined && !text(candidate.mark, 20))
      || (candidate.badge !== undefined && !text(candidate.badge, 30))) return undefined;
    try {
      const url = new URL(candidate.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    } catch { return undefined; }
    const category = LEGACY_CATEGORIES.has(candidate.category) ? 'tools' : candidate.category;
    if (!CATEGORIES.has(category) && !navigationIds.has(category)) return undefined;
    siteIds.add(candidate.id);
    customSites.push({
      id: candidate.id, name: candidate.name.trim(), url: candidate.url, desc: candidate.desc,
      category, tags: [...candidate.tags] as string[], isCustom: true,
      ...(typeof candidate.mark === 'string' ? { mark: candidate.mark } : {}),
      ...(typeof candidate.badge === 'string' ? { badge: candidate.badge } : {}),
    });
  }
  if (!value.favorites.every((id) => text(id, 80) && IDENTIFIER.test(id))) return undefined;
  return { favorites: [...new Set(value.favorites as string[])], customSites, customNavigations };
}

export function createNavigationApi(resolveIdentity: IdentityResolver = accessIdentity) {
  const api = new Hono<AppEnv>();
  api.use('*', bodyLimit({
    maxSize: 512 * 1024,
    onError: (c) => c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Navigation snapshot exceeds 512 KiB' } }, 413),
  }));

  async function identity(c: Parameters<IdentityResolver>[0]) {
    const signedIn = await resolveIdentity(c);
    if (!signedIn?.email.trim()) return undefined;
    const email = signedIn.email.trim().toLowerCase();
    return { id: await accountId(email), email };
  }

  api.get('/', async (c) => {
    const account = await identity(c);
    if (!account) return c.json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in is required' } }, 401);
    const profile = await c.env.CHECKLISTS_DB.prepare(
      "SELECT snapshot, revision, strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AS updated_at FROM account_navigation_profiles WHERE account_id = ?",
    ).bind(account.id).first<{ snapshot: string; revision: number; updated_at: string }>();
    const navigation = profile ? parseNavigationData(JSON.parse(profile.snapshot)) : EMPTY;
    if (!navigation) throw new Error('Stored navigation snapshot is invalid');
    return c.json({ data: { account, initialized: Boolean(profile), revision: profile?.revision ?? 0, updatedAt: profile?.updated_at ?? null, navigation } });
  });

  api.post('/', async (c) => {
    const account = await identity(c);
    if (!account) return c.json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in is required' } }, 401);
    if (c.req.header('Origin') !== 'https://sgao.cc') return c.json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Navigation writes require the main-site origin' } }, 403);
    let payload: unknown;
    try { payload = await c.req.json(); }
    catch { return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' } }, 400); }
    if (!object(payload) || Object.keys(payload).some((key) => !['accountId', 'revision', 'navigation'].includes(key))
      || typeof payload.revision !== 'number' || !Number.isSafeInteger(payload.revision) || payload.revision < 0
      || typeof payload.accountId !== 'string') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Navigation revision or account ID is invalid' } }, 400);
    }
    if (payload.accountId !== account.id) return c.json({ error: { code: 'ACCOUNT_CHANGED', message: 'The signed-in account changed' } }, 409);
    const navigation = parseNavigationData(payload.navigation);
    if (!navigation) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Navigation snapshot is invalid; private history is not accepted' } }, 400);
    const results = await c.env.CHECKLISTS_DB.batch([
      c.env.CHECKLISTS_DB.prepare(
        'INSERT INTO account_navigation_profiles (account_id, snapshot, revision) SELECT ?, ?, 0 WHERE ? = 0 ON CONFLICT(account_id) DO NOTHING',
      ).bind(account.id, JSON.stringify(EMPTY), payload.revision),
      c.env.CHECKLISTS_DB.prepare(
        "UPDATE account_navigation_profiles SET snapshot = ?, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE account_id = ? AND revision = ? RETURNING revision, updated_at",
      ).bind(JSON.stringify(navigation), account.id, payload.revision),
    ]);
    const saved = results[1]?.results[0] as { revision: number; updated_at: string } | undefined;
    if (!saved) return c.json({ error: { code: 'SYNC_CONFLICT', message: 'Navigation changed on another device' } }, 409);
    return c.json({ data: { account, initialized: true, revision: saved.revision, updatedAt: saved.updated_at, navigation } });
  });
  return api;
}
