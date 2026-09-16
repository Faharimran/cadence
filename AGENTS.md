# cadence

Multi-tenant scheduling, availability and conversation infrastructure. Businesses either
enter their operational data through cadence's own admin UI, or cadence brokers it from
the CRM/ERP they already run. Either way the conversation layer answers and books against
**live** state, and the business gets an API and webhooks back.

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ
from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before
writing any code. Heed deprecation notices. Notably: Turbopack is the default (no
`--turbopack` flag), middleware is now `proxy.ts`, route `params` and `headers()` are
async, and route handlers are uncached by default.

## Architecture rules

1. **The engine owns no vertical.** `lib/engine/` must never mention doctors, patients,
   treatments, clinics, GST, or IST. It knows Resources, Services, Locations, Customers.
   The ESLint boundary in `eslint.config.mjs` enforces the import half of this; the naming
   half is on review.

   This extends past the engine to **the prompt**. What a business is, how it should sound
   and what it refuses to answer are `Tenant.descriptor`, `Tenant.toneNote` and
   `Tenant.escalationTopics` — never string literals in `lib/conversation/agent.ts`. The
   test is in `scripts/proveKnowledge.ts`: a barber's prompt must not contain the word
   "clinical". `lib/presets.ts` writes ordinary rows and is then never read again, and
   nothing anywhere may branch on `Tenant.vertical`.

2. **Never store derived availability.** There is no `isAvailable` column and there never
   will be. Availability is computed per query from three layers:
   `recurring schedule` − `exceptions` + `extra sessions` − `bookings`. A cached answer is
   a wrong answer waiting for a race.

3. **Snapshots speak, the source of truth promises.** The conversation layer may *offer*
   slots from a cached snapshot. It may only *commit* through a hold placed against the
   live source of truth. Every write path is idempotent and guarded at the database level,
   not in application code.

4. **Vocabulary is data, behaviour is code.** Tenants define their own exception types,
   service categories and tags. They do not define *effects* — `add` and `subtract` are a
   closed set the engine owns. Resist any request to make effects configurable; that road
   ends in an unversioned DSL with no debugger.

5. **Every tenant-scoped table carries `tenantId` and is protected by RLS.** Application
   filters are the fast path, row-level security is the backstop. A forgotten `where`
   clause must return zero rows, not another tenant's calendar.

6. **All instants are UTC `timestamptz`; all business hours are local wall-clock strings.**
   Resolution happens at query time against the location's IANA timezone. There is no
   default timezone in this codebase — a missing timezone is an error, not an assumption.
   Nor a default currency, for the same reason.

7. **The assistant may only repeat what the business approved.** A `KnowledgeDoc` reaches a
   customer at status `approved` and at no other; editing approved text returns it to
   `draft`, and the last approved revision stays live until someone signs the new one off.
   The prompt states in all three branches — empty, inline, index — that anything not
   written down is not known. A model filling that gap from what it knows about the
   industry is inventing a promise the business then has to honour.

8. **Uploads land as drafts, and the model titles rather than writes.** An uploaded
   company document routinely carries dealer cost, margin bands and staff instructions, so
   there is no upload-to-live path and there must never be one. Ingestion may decide what
   question a passage answers and whether to keep it at all; the body stays byte-for-byte
   the document's own words. The uploaded file itself is never stored — the bytes sit in
   Redis under a one-hour TTL between the request and the worker, and only the extracted
   text is kept.

9. **The operator console shows counts, never a customer.** `/platform` is the one
   surface that reads across tenants, on the owner connection, which RLS does not
   constrain — so `lib/platform/metrics.ts` may select aggregates, staff emails and
   hostnames, and must never select `Customer.name`, `Customer.phone`,
   `ConversationMessage.body`, or any stored secret. Operators are a separate table with
   their own cookie and their own HMAC domain: a tenant session cannot open the console
   and an operator session cannot open a tenant admin. `scripts/provePlatform.ts` asserts
   both, and requires each page to return 200 before trusting a negative assertion.

10. **Whose key answers is data; how to speak to it is code.** A business may run its
   conversations on its own model credentials (`ModelProvider`) or on cadence's, and no
   row means ours. The endpoint and the model id are theirs to type; the wire protocol is
   a closed set of two — `anthropic` and `openai` — each with a driver under
   `lib/conversation/drivers/`. Adding DeepSeek or Groq is a row in `VENDORS`; adding a
   protocol is a driver someone wrote and read. There is deliberately **no fallback
   between a tenant's key and the platform's**: a credential failure hands the thread to a
   colleague (`failureResponse`), because silently spending ours is a bill they never
   agreed to and a broken integration nobody would notice. Ingestion stays on the platform
   key. `scripts/proveModelProviders.ts` asserts all of it, without calling a model.

## What cadence is not

It books **appointments** — something a customer occupies for a duration. Retail and food
service are a different transaction (an order, with stock and fulfilment) and no preset
bridges that gap. Say so rather than stretching the model to fit.

## Layout

| Path | Holds |
|---|---|
| `lib/engine/` | Availability, holds, bookings, promotions. The sellable core. |
| `lib/conversation/` | Agent loop, tool assembly, snapshots, and which provider answers. |
| `lib/conversation/drivers/` | One per wire protocol. The only place a model is actually called. |
| `lib/knowledge/` | Retrieval, PDF extraction, chunking, ingestion. |
| `lib/platform/` | Operator console: its own session, guard and metrics. |
| `lib/channels/` | WhatsApp, web widget, etc. Transport only. |
| `lib/connectors/` | Per-CRM adapters implementing the canonical interface. |
| `lib/api/` | Auth, tenant context, idempotency, error shapes. |
| `app/api/v1/` | The public REST API. |
| `workers/` | BullMQ consumers: hold expiry, reconciliation, webhook delivery. |
