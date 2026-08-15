export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/') {
			return Response.json({
				name: 'sgao-api',
				message: 'Welcome to SGAO API',
			});
		}

		if (url.pathname === '/health') {
			return Response.json({
				status: 'ok',
				service: 'sgao-api',
				timestamp: new Date().toISOString(),
			});
		}

		return Response.json(
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
