import { Hono } from 'hono';
import type { Context } from 'hono';

const TODO_ORIGIN = 'https://todo.sgao.cc';
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_LISTS = 100;
const MAX_ITEMS_PER_LIST = 300;
const MAX_TOTAL_ITEMS = 500;
const ROWS_PER_INSERT = 16;

type AppEnv = { Bindings: Env };
type AccountIdentity = { email: string };
export type IdentityResolver = (c: Context<AppEnv>) => Promise<AccountIdentity | undefined>;
type SyncedItem = { id: string; label: string; checked: boolean };
type SyncedChecklist = {
	id: string;
	slug: string;
	title: string;
	description: string;
	items: SyncedItem[];
};

function apiError(c: Context<AppEnv>, status: 400 | 401 | 404 | 409 | 500, code: string, message: string) {
	return c.json({ error: { code, message } }, status);
}

function validString(value: unknown, maxLength: number): value is string {
	return typeof value === 'string' && value.length <= maxLength;
}

export function parseSnapshot(value: unknown): SyncedChecklist[] | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const lists = (value as { lists?: unknown }).lists;
	if (!Array.isArray(lists) || lists.length > MAX_LISTS) return undefined;

	const listIds = new Set<string>();
	const slugs = new Set<string>();
	const parsed: SyncedChecklist[] = [];
	let totalItems = 0;
	for (const candidate of lists) {
		if (!candidate || typeof candidate !== 'object') return undefined;
		const list = candidate as Record<string, unknown>;
		if (
			!validString(list.id, 80)
			|| !IDENTIFIER_PATTERN.test(list.id)
			|| !validString(list.slug, 60)
			|| !SLUG_PATTERN.test(list.slug)
			|| !validString(list.title, 60)
			|| !list.title.trim()
			|| !validString(list.description, 160)
			|| !Array.isArray(list.items)
			|| list.items.length > MAX_ITEMS_PER_LIST
			|| listIds.has(list.id)
			|| slugs.has(list.slug)
		) return undefined;
		totalItems += list.items.length;
		if (totalItems > MAX_TOTAL_ITEMS) return undefined;

		const itemIds = new Set<string>();
		const items: SyncedItem[] = [];
		for (const itemCandidate of list.items) {
			if (!itemCandidate || typeof itemCandidate !== 'object') return undefined;
			const item = itemCandidate as Record<string, unknown>;
			if (
				!validString(item.id, 80)
				|| !IDENTIFIER_PATTERN.test(item.id)
				|| !validString(item.label, 100)
				|| !item.label.trim()
				|| typeof item.checked !== 'boolean'
				|| itemIds.has(item.id)
			) return undefined;
			itemIds.add(item.id);
			items.push({ id: item.id, label: item.label.trim(), checked: item.checked });
		}

		listIds.add(list.id);
		slugs.add(list.slug);
		parsed.push({
			id: list.id,
			slug: list.slug,
			title: list.title.trim(),
			description: list.description.trim(),
			items,
		});
	}
	return parsed;
}

function parseRevision(value: unknown): number | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const revision = (value as { revision?: unknown }).revision;
	return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
		? revision
		: undefined;
}

export async function accountId(email: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(email.trim().toLowerCase()),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function accessIdentity(c: Context<AppEnv>): Promise<AccountIdentity | undefined> {
	const executionCtx = c.executionCtx as ExecutionContext & { access?: CloudflareAccessContext };
	const identity = await executionCtx.access?.getIdentity();
	return typeof identity?.email === 'string' && identity.email.trim()
		? { email: identity.email.trim().toLowerCase() }
		: undefined;
}

export function createAccountApi(resolveIdentity: IdentityResolver = accessIdentity) {
	const accountApi = new Hono<AppEnv>();

	async function account(c: Context<AppEnv>) {
		const identity = await resolveIdentity(c);
		if (!identity) return undefined;
		const email = identity.email.trim().toLowerCase();
		return { id: await accountId(email), email };
	}

	accountApi.get('/login', async (c) => {
		const signedIn = await account(c);
		if (!signedIn) return apiError(c, 401, 'AUTH_REQUIRED', 'Sign in is required');
		const returnTo = c.req.query('returnTo');
		if (returnTo) {
			try {
				const url = new URL(returnTo);
				if (url.origin === TODO_ORIGIN) return c.redirect(url.toString(), 302);
			} catch {
				// Fall through to the JSON session response.
			}
		}
		return c.json({ data: { account: signedIn } });
	});

	accountApi.get('/session', async (c) => {
		const signedIn = await account(c);
		if (!signedIn) return apiError(c, 401, 'AUTH_REQUIRED', 'Sign in is required');
		return c.json({ data: { account: signedIn } });
	});

	accountApi.get('/checklists', async (c) => {
		const signedIn = await account(c);
		if (!signedIn) return apiError(c, 401, 'AUTH_REQUIRED', 'Sign in is required');

		const profile = await c.env.CHECKLISTS_DB.prepare(
			`SELECT account_id, revision,
				strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) AS updated_at
			FROM account_profiles WHERE account_id = ?`,
		).bind(signedIn.id).first<{ account_id: string; revision: number; updated_at: string }>();
		if (!profile) {
			return c.json({ data: { account: signedIn, initialized: false, revision: 0, updatedAt: null, lists: [] } });
		}

		const [listsResult, itemsResult] = await c.env.CHECKLISTS_DB.batch([
			c.env.CHECKLISTS_DB.prepare(
				'SELECT checklist_id, slug, title, description FROM account_checklists WHERE account_id = ? ORDER BY position',
			).bind(signedIn.id),
			c.env.CHECKLISTS_DB.prepare(
				'SELECT checklist_id, item_id, label, checked FROM account_checklist_items WHERE account_id = ? ORDER BY checklist_id, position',
			).bind(signedIn.id),
		]);
		const itemsByList = new Map<string, SyncedItem[]>();
		for (const row of itemsResult.results as Array<Record<string, unknown>>) {
			const checklistId = String(row.checklist_id);
			const items = itemsByList.get(checklistId) ?? [];
			items.push({ id: String(row.item_id), label: String(row.label), checked: Number(row.checked) === 1 });
			itemsByList.set(checklistId, items);
		}
		const lists = (listsResult.results as Array<Record<string, unknown>>).map((row) => ({
			id: String(row.checklist_id),
			slug: String(row.slug),
			title: String(row.title),
			description: String(row.description),
			items: itemsByList.get(String(row.checklist_id)) ?? [],
		}));
		return c.json({
			data: {
				account: signedIn,
				initialized: true,
				revision: Number(profile.revision),
				updatedAt: profile.updated_at,
				lists,
			},
		});
	});

	accountApi.post('/checklists', async (c) => {
		const signedIn = await account(c);
		if (!signedIn) return apiError(c, 401, 'AUTH_REQUIRED', 'Sign in is required');
		let payload: unknown;
		try {
			payload = await c.req.json();
		} catch {
			return apiError(c, 400, 'VALIDATION_ERROR', 'Request body must be valid JSON');
		}
		const revision = parseRevision(payload);
		if (revision === undefined) return apiError(c, 400, 'VALIDATION_ERROR', 'Snapshot revision is invalid');
		const lists = parseSnapshot(payload);
		if (!lists) return apiError(c, 400, 'VALIDATION_ERROR', 'Checklist snapshot is invalid');

		const statements: D1PreparedStatement[] = [
			c.env.CHECKLISTS_DB.prepare(
				'INSERT INTO account_profiles (account_id, revision) SELECT ?, 0 WHERE ? = 0 ON CONFLICT(account_id) DO NOTHING',
			).bind(signedIn.id, revision),
			c.env.CHECKLISTS_DB.prepare(
				`DELETE FROM account_checklist_items
				WHERE account_id = ? AND EXISTS (
					SELECT 1 FROM account_profiles WHERE account_id = ? AND revision = ?
				)`,
			).bind(signedIn.id, signedIn.id, revision),
			c.env.CHECKLISTS_DB.prepare(
				`DELETE FROM account_checklists
				WHERE account_id = ? AND EXISTS (
					SELECT 1 FROM account_profiles WHERE account_id = ? AND revision = ?
				)`,
			).bind(signedIn.id, signedIn.id, revision),
		];
		const listRows = lists.map((list, position): Array<string | number> => [
			signedIn.id, list.id, list.slug, list.title, list.description, position,
		]);
		for (let index = 0; index < listRows.length; index += ROWS_PER_INSERT) {
			const rows = listRows.slice(index, index + ROWS_PER_INSERT);
			const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
			statements.push(c.env.CHECKLISTS_DB.prepare(
				`WITH rows(account_id, checklist_id, slug, title, description, position) AS (VALUES ${placeholders})
				INSERT INTO account_checklists (account_id, checklist_id, slug, title, description, position)
				SELECT account_id, checklist_id, slug, title, description, position FROM rows
				WHERE EXISTS (
					SELECT 1 FROM account_profiles WHERE account_id = ? AND revision = ?
				)`,
			).bind(...rows.flat(), signedIn.id, revision));
		}
		const itemRows = lists.flatMap((list) => list.items.map((item, position): Array<string | number> => [
			signedIn.id, list.id, item.id, item.label, item.checked ? 1 : 0, position,
		]));
		for (let index = 0; index < itemRows.length; index += ROWS_PER_INSERT) {
			const rows = itemRows.slice(index, index + ROWS_PER_INSERT);
			const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
			statements.push(c.env.CHECKLISTS_DB.prepare(
				`WITH rows(account_id, checklist_id, item_id, label, checked, position) AS (VALUES ${placeholders})
				INSERT INTO account_checklist_items (account_id, checklist_id, item_id, label, checked, position)
				SELECT account_id, checklist_id, item_id, label, checked, position FROM rows
				WHERE EXISTS (
					SELECT 1 FROM account_profiles WHERE account_id = ? AND revision = ?
				)`,
			).bind(...rows.flat(), signedIn.id, revision));
		}
		statements.push(c.env.CHECKLISTS_DB.prepare(
			`UPDATE account_profiles
			SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			WHERE account_id = ? AND revision = ?`,
		).bind(signedIn.id, revision));
		const results = await c.env.CHECKLISTS_DB.batch(statements);
		const revisionUpdate = results.at(-1);
		if (!revisionUpdate || revisionUpdate.meta.changes !== 1) {
			return apiError(c, 409, 'SYNC_CONFLICT', 'The account snapshot changed on another device');
		}

		const savedProfile = await c.env.CHECKLISTS_DB.prepare(
			`SELECT revision, strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) AS updated_at
			FROM account_profiles WHERE account_id = ?`,
		).bind(signedIn.id).first<{ revision: number; updated_at: string }>();
		if (!savedProfile) return apiError(c, 500, 'INTERNAL_ERROR', 'Saved account profile is unavailable');
		return c.json({
			data: {
				saved: true,
				listCount: lists.length,
				revision: Number(savedProfile.revision),
				updatedAt: savedProfile.updated_at,
			},
		});
	});

	return accountApi;
}
