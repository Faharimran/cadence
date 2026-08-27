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

## Layout

| Path | Holds |
|---|---|
| `lib/engine/` | Availability, holds, bookings, promotions. The sellable core. |
| `lib/conversation/` | Agent loop, tool assembly, snapshots, knowledge. |
| `lib/channels/` | WhatsApp, web widget, etc. Transport only. |
| `lib/connectors/` | Per-CRM adapters implementing the canonical interface. |
| `lib/api/` | Auth, tenant context, idempotency, error shapes. |
| `app/api/v1/` | The public REST API. |
| `workers/` | BullMQ consumers: hold expiry, reconciliation, webhook delivery. |
