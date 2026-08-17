import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import worker from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("sgao-api worker", () => {
	beforeEach(async () => {
		await env.CHECKLISTS_DB.prepare("DROP TABLE IF EXISTS checklist_items").run();
		await env.CHECKLISTS_DB.prepare(
			`CREATE TABLE checklist_items (
				visitor_id TEXT NOT NULL,
				trip_id TEXT NOT NULL,
				item_id TEXT NOT NULL,
				checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY (visitor_id, trip_id, item_id)
			)`,
		).run();
	});

	it("returns service metadata from the root endpoint (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.json()).toEqual({
			name: "sgao-api",
			version: "0.1.0",
			message: "Welcome to SGAO API",
		});
	});

	it("returns service metadata from the root endpoint (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(await response.json()).toEqual({
			name: "sgao-api",
			version: "0.1.0",
			message: "Welcome to SGAO API",
		});
	});

	it("persists an anonymous visitor's checklist items", async () => {
		const visitorId = "f4d1456f-8590-4acf-9c0e-4c6b6e7d4e81";
		const headers = {
			Origin: "https://travel.sgao.cc",
			"X-Checklist-Visitor": visitorId,
		};

		const updateResponse = await worker.fetch(
			new IncomingRequest("https://api.sgao.cc/api/v1/checklists/shenyang-dandong-dalian/items/id-card", {
				method: "PUT",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ checked: true }),
			}),
			env,
			createExecutionContext(),
		);
		expect(updateResponse.status).toBe(200);
		expect(updateResponse.headers.get("Access-Control-Allow-Origin")).toBe("https://travel.sgao.cc");
		expect(await updateResponse.json()).toEqual({
			data: {
				tripId: "shenyang-dandong-dalian",
				itemId: "id-card",
				checked: true,
			},
		});

		const readResponse = await worker.fetch(
			new IncomingRequest("https://api.sgao.cc/api/v1/checklists/shenyang-dandong-dalian", { headers }),
			env,
			createExecutionContext(),
		);
		expect(await readResponse.json()).toEqual({
			data: {
				tripId: "shenyang-dandong-dalian",
				checkedItemIds: ["id-card"],
			},
		});

		const legacyResponse = await worker.fetch(
			new IncomingRequest("https://api.sgao.cc/v1/checklists/shenyang-dandong-dalian", { headers }),
			env,
			createExecutionContext(),
		);
		expect(await legacyResponse.json()).toEqual({
			tripId: "shenyang-dandong-dalian",
			checkedItemIds: ["id-card"],
		});
	});

	it("handles checklist CORS preflight requests", async () => {
		const response = await worker.fetch(
			new IncomingRequest("https://api.sgao.cc/api/v1/checklists/shenyang-dandong-dalian", {
				method: "OPTIONS",
				headers: {
					Origin: "https://travel.sgao.cc",
					"Access-Control-Request-Method": "PUT",
				},
			}),
			env,
			createExecutionContext(),
		);

		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://travel.sgao.cc");
	});
});
