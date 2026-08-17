sgao-api

Sgao API - Backend API service powered by Cloudflare Workers.

About

sgao-api 是 sgao.cc 的统一后端 API 服务。

计划使用：

- TypeScript
- Hono
- Cloudflare Workers

未来将通过以下域名提供 API 服务：

https://api.sgao.cc

Status

🚧 Project initialization in progress.

Checklist API

`api.sgao.cc` stores each checklist against an anonymous browser identifier. The
identifier is generated once in the browser and stored in `localStorage`; it is
not an account or a personal profile. Only requests from `https://travel.sgao.cc`
are allowed to call these endpoints from a browser.

```text
GET /api/v1/checklists/:tripId
PUT /api/v1/checklists/:tripId/items/:itemId
```

Pass the identifier in the `X-Checklist-Visitor` header. A successful response
uses `{ data: ... }`; errors use `{ error: { code, message } }`. A `GET`
returns `{ data: { tripId, checkedItemIds } }`. A `PUT` accepts
`{ checked: true | false }`.

The former `/v1/checklists/...` endpoints remain available temporarily with the
original response shape for compatibility.

```ts
const API_ORIGIN = "https://api.sgao.cc";
const tripId = "shenyang-dandong-dalian";
const visitorKey = "sgao.travel.checklist.visitor";
let visitorId = localStorage.getItem(visitorKey);

if (!visitorId) {
  visitorId = crypto.randomUUID();
  localStorage.setItem(visitorKey, visitorId);
}

const headers = {
  "Content-Type": "application/json",
  "X-Checklist-Visitor": visitorId,
};

export async function loadChecklist() {
  const response = await fetch(`${API_ORIGIN}/api/v1/checklists/${tripId}`, { headers });
  return response.json();
}

export async function setChecked(itemId: string, checked: boolean) {
  await fetch(`${API_ORIGIN}/api/v1/checklists/${tripId}/items/${itemId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ checked }),
  });
}
```

Apply the D1 schema before deploying the Worker:

```sh
npx wrangler d1 execute sgao-api-checklists --remote --file=migrations/0001_checklist_items.sql
```
