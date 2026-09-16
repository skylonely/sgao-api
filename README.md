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

The only supported checklist API prefix is `/api/v1/...`.

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

Account checklist sync

Account endpoints are intended to be protected by a hostname/path Cloudflare
Access application for `api.sgao.cc/api/v1/account/*`. The Worker reads the
verified email from `ctx.access`; it never accepts an email from the request and
stores only a SHA-256 account identifier in D1.

```text
GET  /api/v1/account/login?returnTo=https://todo.sgao.cc/...
GET  /api/v1/account/session
GET  /api/v1/account/checklists
POST /api/v1/account/checklists
```

`GET /checklists` returns the full account snapshot together with `revision` and
`updatedAt`. A `POST` must send the revision it last read alongside `lists`.
Writes atomically replace the small snapshot and increment the revision; a stale
revision returns `409 SYNC_CONFLICT` without changing stored data. Browser
requests are credentialed; the account CORS whitelist contains only
`https://todo.sgao.cc` and `https://sgao.cc`. Checklist writes continue to require
the Todo origin; navigation writes require the main-site origin. The
write uses `text/plain` JSON so it remains a simple CORS request and does not
require an unauthenticated preflight through Access. A checklist may include a
nullable ISO `deletedAt` timestamp; the Todo frontend uses it to synchronize the
30-day recycle bin across devices.

Apply the account schema before deploying:

```sh
npx wrangler d1 execute sgao-api-checklists --remote --file=migrations/0002_account_checklists.sql
npx wrangler d1 execute sgao-api-checklists --remote --file=migrations/0003_account_revision.sql
npx wrangler d1 execute sgao-api-checklists --remote --file=migrations/0004_checklist_recycle_bin.sql
```

In Cloudflare Zero Trust, create a self-hosted application for only the account
path above and add an Allow policy for the intended email address(es). Do not
protect all of `api.sgao.cc`, because the existing anonymous checklist endpoints
must remain public.

Account navigation sync

The main site reuses the same verified Access identity and login route, with
`returnTo=https://sgao.cc/...`. Login redirects accept only the exact main-site
and Todo origins, without embedded credentials. Account responses use
`Cache-Control: private, no-store`.

```text
GET  /api/v1/account/navigation
POST /api/v1/account/navigation
```

Navigation uses the independent `account_navigation_profiles` table in the
existing D1 database; no checklist table is changed. GET returns
`{ data: { account, initialized, revision, updatedAt, navigation } }`.
POST accepts `{ accountId, revision, navigation }`; the supplied account ID must
match the verified identity, and the revision must match the stored snapshot.
An account switch or stale revision returns 409 without replacing existing data.
Creation starts at revision 0 and successful writes increment the revision.

`navigation` contains only `favorites`, `customSites`, and `customNavigations`.
History, search records and display preferences are not accepted or stored.
Payloads are limited to 512 KiB, 1,000 favorites, 500 custom sites and 100 custom
categories. IDs must be unique and references valid; links must be HTTP/HTTPS
without embedded credentials. The main frontend presents an explicit first-login
merge/cloud choice, handles conflicts, and keeps offline edits locally.

For the first release, separately confirm and apply the additive schema before
deploying this API, then deploy the main frontend:

```sh
npx wrangler d1 execute sgao-api-checklists --remote --file=migrations/0005_account_navigation.sql
```

Local verification: `npm test -- --run` and `npx tsc --noEmit`. Worker tests use
isolated test databases; they do not apply migrations to production.
