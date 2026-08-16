const TRAVEL_ORIGIN = 'https://travel.sgao.cc';
const VISITOR_ID_PATTERN = /^[a-z0-9_-]{16,128}$/i;

type ChecklistUpdate = {
	checked?: unknown;
};

function corsHeaders(request: Request): Headers {
	const headers = new Headers({ Vary: 'Origin' });

	if (request.headers.get('Origin') === TRAVEL_ORIGIN) {
		headers.set('Access-Control-Allow-Origin', TRAVEL_ORIGIN);
		headers.set('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
		headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Checklist-Visitor');
	}

	return headers;
}

function json(request: Request, body: unknown, init: ResponseInit = {}): Response {
	const headers = corsHeaders(request);
	new Headers(init.headers).forEach((value, key) => headers.set(key, value));
	return Response.json(body, { ...init, headers });
}

function invalidRequest(request: Request, message: string): Response {
	return json(request, { code: 400, message }, { status: 400 });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const cors = corsHeaders(request);

		if (request.method === 'OPTIONS' && request.headers.get('Origin') === TRAVEL_ORIGIN) {
			return new Response(null, { status: 204, headers: cors });
		}

		if (url.pathname === '/') {
			return json(request, {
				name: 'sgao-api',
				version: '0.1.0',
				message: 'Welcome to SGAO API',
			});
		}

		if (url.pathname === '/health') {
			return json(request, {
				status: 'ok',
				service: 'sgao-api',
				timestamp: new Date().toISOString(),
			});
		}

		const checklistRoute = url.pathname.match(
			/^\/v1\/checklists\/([a-z0-9][a-z0-9_-]{0,79})(?:\/items\/([a-z0-9][a-z0-9_-]{0,79}))?$/,
		);
		if (checklistRoute) {
			const [, tripId, itemId] = checklistRoute;
			const visitorId = request.headers.get('X-Checklist-Visitor');

			if (!visitorId || !VISITOR_ID_PATTERN.test(visitorId)) {
				return invalidRequest(request, 'A valid X-Checklist-Visitor header is required');
			}

			if (request.method === 'GET' && !itemId) {
				const { results } = await env.CHECKLISTS_DB.prepare(
					'SELECT item_id FROM checklist_items WHERE visitor_id = ? AND trip_id = ? ORDER BY item_id',
				)
					.bind(visitorId, tripId)
					.all<{ item_id: string }>();

				return json(request, {
					tripId,
					checkedItemIds: results.map((item) => item.item_id),
				});
			}

			if (request.method === 'PUT' && itemId) {
				let payload: ChecklistUpdate;
				try {
					payload = await request.json<ChecklistUpdate>();
				} catch {
					return invalidRequest(request, 'Request body must be valid JSON');
				}

				if (typeof payload.checked !== 'boolean') {
					return invalidRequest(request, 'checked must be a boolean');
				}

				if (payload.checked) {
					await env.CHECKLISTS_DB.prepare(
						'INSERT OR REPLACE INTO checklist_items (visitor_id, trip_id, item_id) VALUES (?, ?, ?)',
					)
						.bind(visitorId, tripId, itemId)
						.run();
				} else {
					await env.CHECKLISTS_DB.prepare(
						'DELETE FROM checklist_items WHERE visitor_id = ? AND trip_id = ? AND item_id = ?',
					)
						.bind(visitorId, tripId, itemId)
						.run();
				}

				return json(request, { tripId, itemId, checked: payload.checked });
			}

			return json(request, { code: 405, message: 'Method not allowed' }, { status: 405 });
		}

		return json(
			request,
			{
				code: 404,
				message: 'API route not found',
			},
			{
				status: 404,
			},
		);
	},
} satisfies ExportedHandler<Env>;
