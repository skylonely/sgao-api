import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';

const TRAVEL_ORIGIN = 'https://travel.sgao.cc';
const VISITOR_ID_PATTERN = /^[a-z0-9_-]{16,128}$/i;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

type AppEnv = { Bindings: Env };
type ChecklistUpdate = { checked?: unknown };
type ChecklistState = { tripId: string; checkedItemIds: string[] };
type ChecklistItemState = { tripId: string; itemId: string; checked: boolean };
type ApiPayload = ChecklistState | ChecklistItemState;

const app = new Hono<AppEnv>();
const apiV1 = new Hono<AppEnv>();
const legacyV1 = new Hono<AppEnv>();

const checklistCors = cors({
	origin: TRAVEL_ORIGIN,
	allowMethods: ['GET', 'PUT', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'X-Checklist-Visitor'],
	maxAge: 86_400,
});

function apiError(c: Context<AppEnv>, status: 400 | 404 | 405 | 500, code: string, message: string) {
	return c.json({ error: { code, message } }, status);
}

function visitorId(c: Context<AppEnv>): string | undefined {
	const value = c.req.header('X-Checklist-Visitor');
	return value && VISITOR_ID_PATTERN.test(value) ? value : undefined;
}

function validIdentifier(value: string): boolean {
	return IDENTIFIER_PATTERN.test(value);
}

function registerChecklistRoutes(
	router: Hono<AppEnv>,
	respond: (c: Context<AppEnv>, payload: ApiPayload) => Response,
) {
	router.get('/checklists/:tripId', async (c) => {
		const tripId = c.req.param('tripId');
		const anonymousVisitorId = visitorId(c);

		if (!validIdentifier(tripId)) {
			return apiError(c, 400, 'VALIDATION_ERROR', 'tripId is invalid');
		}
		if (!anonymousVisitorId) {
			return apiError(c, 400, 'VALIDATION_ERROR', 'A valid X-Checklist-Visitor header is required');
		}

		const { results } = await c.env.CHECKLISTS_DB.prepare(
			'SELECT item_id FROM checklist_items WHERE visitor_id = ? AND trip_id = ? ORDER BY item_id',
		)
			.bind(anonymousVisitorId, tripId)
			.all<{ item_id: string }>();

		return respond(c, { tripId, checkedItemIds: results.map((item) => item.item_id) });
	});

	router.put('/checklists/:tripId/items/:itemId', async (c) => {
		const { tripId, itemId } = c.req.param();
		const anonymousVisitorId = visitorId(c);

		if (!validIdentifier(tripId) || !validIdentifier(itemId)) {
			return apiError(c, 400, 'VALIDATION_ERROR', 'tripId or itemId is invalid');
		}
		if (!anonymousVisitorId) {
			return apiError(c, 400, 'VALIDATION_ERROR', 'A valid X-Checklist-Visitor header is required');
		}

		let payload: ChecklistUpdate;
		try {
			payload = await c.req.json<ChecklistUpdate>();
		} catch {
			return apiError(c, 400, 'VALIDATION_ERROR', 'Request body must be valid JSON');
		}
		if (typeof payload.checked !== 'boolean') {
			return apiError(c, 400, 'VALIDATION_ERROR', 'checked must be a boolean');
		}

		if (payload.checked) {
			await c.env.CHECKLISTS_DB.prepare(
				'INSERT OR REPLACE INTO checklist_items (visitor_id, trip_id, item_id) VALUES (?, ?, ?)',
			)
				.bind(anonymousVisitorId, tripId, itemId)
				.run();
		} else {
			await c.env.CHECKLISTS_DB.prepare(
				'DELETE FROM checklist_items WHERE visitor_id = ? AND trip_id = ? AND item_id = ?',
			)
				.bind(anonymousVisitorId, tripId, itemId)
				.run();
		}

		return respond(c, { tripId, itemId, checked: payload.checked });
	});
}

app.get('/', (c) =>
	c.json({
		name: 'sgao-api',
		version: '0.1.0',
		message: 'Welcome to SGAO API',
	}),
);

app.get('/health', (c) =>
	c.json({
		status: 'ok',
		service: 'sgao-api',
		timestamp: new Date().toISOString(),
	}),
);

app.use('/api/*', checklistCors);
app.use('/v1/*', checklistCors);

registerChecklistRoutes(apiV1, (c, payload) => c.json({ data: payload }));
registerChecklistRoutes(legacyV1, (c, payload) => c.json(payload));

app.route('/api/v1', apiV1);
app.route('/v1', legacyV1);

app.notFound((c) => apiError(c, 404, 'NOT_FOUND', 'API route not found'));
app.onError((error, c) => {
	console.error(error);
	return apiError(c, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
});

export default app;
