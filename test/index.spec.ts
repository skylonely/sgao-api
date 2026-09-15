import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import worker from "../src/index";
import { createAccountApi } from "../src/account";

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
		await env.CHECKLISTS_DB.prepare("DROP TABLE IF EXISTS account_checklist_items").run();
		await env.CHECKLISTS_DB.prepare("DROP TABLE IF EXISTS account_checklists").run();
		await env.CHECKLISTS_DB.prepare("DROP TABLE IF EXISTS account_profiles").run();
		await env.CHECKLISTS_DB.batch([
			env.CHECKLISTS_DB.prepare(`CREATE TABLE account_profiles (
				account_id TEXT PRIMARY KEY,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`),
			env.CHECKLISTS_DB.prepare(`CREATE TABLE account_checklists (
				account_id TEXT NOT NULL,
				checklist_id TEXT NOT NULL,
				slug TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				position INTEGER NOT NULL,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY (account_id, checklist_id),
				UNIQUE (account_id, slug)
			)`),
			env.CHECKLISTS_DB.prepare(`CREATE TABLE account_checklist_items (
				account_id TEXT NOT NULL,
				checklist_id TEXT NOT NULL,
				item_id TEXT NOT NULL,
				label TEXT NOT NULL,
				checked INTEGER NOT NULL DEFAULT 0,
				position INTEGER NOT NULL,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY (account_id, checklist_id, item_id)
			)`),
		]);
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
			version: "0.2.0",
			message: "Welcome to SGAO API",
		});
	});

	it("returns service metadata from the root endpoint (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(await response.json()).toEqual({
			name: "sgao-api",
			version: "0.2.0",
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

		const removedLegacyResponse = await worker.fetch(
			new IncomingRequest("https://api.sgao.cc/v1/checklists/shenyang-dandong-dalian", { headers }),
			env,
			createExecutionContext(),
		);
		expect(removedLegacyResponse.status).toBe(404);
		expect(await removedLegacyResponse.json()).toEqual({
			error: { code: "NOT_FOUND", message: "API route not found" },
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

	it("allows credentialed account requests only from the Todo origin", async () => {
		const response = await worker.fetch(
			new IncomingRequest("https://api.sgao.cc/api/v1/account/checklists", {
				method: "OPTIONS",
				headers: {
					Origin: "https://todo.sgao.cc",
					"Access-Control-Request-Method": "POST",
				},
			}),
			env,
			createExecutionContext(),
		);
		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://todo.sgao.cc");
		expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
		expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
	});

	it("requires an Access identity for account endpoints", async () => {
		const api = createAccountApi(async () => undefined);
		const response = await api.fetch(
			new IncomingRequest("https://api.sgao.cc/checklists"),
			env,
			createExecutionContext(),
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: { code: "AUTH_REQUIRED", message: "Sign in is required" },
		});
	});

	it("initializes and restores a signed-in account snapshot", async () => {
		const api = createAccountApi(async () => ({ email: "Owner@SGAO.cc" }));
		const ctx = createExecutionContext();
		const emptyResponse = await api.fetch(
			new IncomingRequest("https://api.sgao.cc/checklists"),
			env,
			ctx,
		);
		const emptyBody = await emptyResponse.json() as {
			data: { initialized: boolean; account: { id: string; email: string }; lists: unknown[] };
		};
		expect(emptyBody.data.initialized).toBe(false);
		expect(emptyBody.data.account.email).toBe("owner@sgao.cc");
		expect(emptyBody.data.account.id).toHaveLength(64);
		expect(emptyBody.data.lists).toEqual([]);

		const lists = [{
			id: "list-weekend",
			slug: "weekend",
			title: "周末出行",
			description: "两天一夜",
			items: [
				{ id: "item-id-card", label: "身份证", checked: true },
				{ id: "item-charger", label: "充电器", checked: false },
			],
		}];
		const saveResponse = await api.fetch(
			new IncomingRequest("https://api.sgao.cc/checklists", {
				method: "POST",
				headers: { "Content-Type": "text/plain;charset=UTF-8" },
				body: JSON.stringify({ lists }),
			}),
			env,
			createExecutionContext(),
		);
		expect(saveResponse.status).toBe(200);
		expect(await saveResponse.json()).toEqual({ data: { saved: true, listCount: 1 } });

		const readResponse = await api.fetch(
			new IncomingRequest("https://api.sgao.cc/checklists"),
			env,
			createExecutionContext(),
		);
		expect(await readResponse.json()).toMatchObject({
			data: { initialized: true, lists },
		});
	});

	it("rejects an invalid account snapshot", async () => {
		const api = createAccountApi(async () => ({ email: "owner@sgao.cc" }));
		const response = await api.fetch(
			new IncomingRequest("https://api.sgao.cc/checklists", {
				method: "POST",
				headers: { "Content-Type": "text/plain;charset=UTF-8" },
				body: JSON.stringify({ lists: [{ id: "bad id" }] }),
			}),
			env,
			createExecutionContext(),
		);
		expect(response.status).toBe(400);
	});
});
