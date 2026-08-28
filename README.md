# cadence

Multi-tenant scheduling, availability and conversation infrastructure.

A business either enters its operational data through cadence's admin UI, or cadence
brokers that data from the CRM/ERP they already run. Either way the conversation layer
answers and books against **live** state — a real free slot, a real person on leave, a
real promotion running today — and the business gets a REST API and webhooks back.

The bet: assistants that can only recite an FAQ are commodity. Ones that can truthfully
say "3pm Thursday is free" and then actually hold it are not.

## Status

| Area | State |
|---|---|
| Multi-tenant schema + row-level security | ✅ built, isolation verified |
| Availability engine (3 layers, precedence, DST, multi-timezone) | ✅ built, 26 assertions passing |
| Holds, bookings, cancellation | ✅ built, concurrency proven |
| REST API (`/v1`) with key auth + idempotency | ✅ availability, holds, bookings |
| Conversation layer — capability-assembled tools, snapshots, guardrails | ✅ built, 30 assertions passing |
| Agent loop against the live model | ✅ verified end to end — books, escalates, hands over |
| Channel adapters (WhatsApp, web) | ⬜ next |
| Connectors (brokered capabilities) | ⬜ next |
| Admin UI | ⬜ next |

## Setup

Needs Postgres 16+ and Redis. The bundled `docker-compose.yml` provides both on
5433/6380; if you already run them natively, point `.env.local` at those instead.

```bash
npm install
cp .env.example .env.local        # then edit

createdb cadence
psql "$DATABASE_URL" -c "CREATE ROLE cadence_app LOGIN PASSWORD 'cadence_app'"
psql "$DATABASE_URL" -c "GRANT USAGE ON SCHEMA public TO cadence_app"

npm run db:push
npm run db:rls -- --verify        # policies + overlap constraint, then prove them
npm run seed:demo                 # prints an API key once
npm run dev
```

`npm run db:rls` must be re-run after every schema change — Prisma does not know
those objects exist.

### Verifying

```bash
curl localhost:3000/api/health
# {"status":"ok","checks":{"database":"ok",
#  "tenantIsolation":"enforced","overlapConstraint":"present"}}

npm run prove          # both harnesses
```

`proveEngine.ts` is the engine's real specification: exception precedence, category
scoping, buffer enforcement, per-location timezones, DST-skipped wall-clock times, and
five concurrent customers racing for one slot.

`live:conversation` drives three real turns against Claude and then asserts against the
database what actually landed. It costs tokens and is non-deterministic, so it is a manual
smoke test rather than CI — what it proves is the part the cheap harness cannot: that the
model resolves "monday morning" to the right instant, holds *before* promising, and hands
over instead of negotiating.

`proveConversation.ts` covers the conversation layer **without calling a model**. Every
tool exposes a plain `run()`, so the dangerous half — the part that reads customer data,
quotes prices and can double-book a room — is verified deterministically, for free, in
CI. It asserts that revoking a capability removes the corresponding tool, that a
non-quotable price never enters the model's context at all, that an internal closure
reason never escapes, that a lost race returns alternatives, and that escalation actually
persists `botPaused` rather than merely reporting success.

## API

All endpoints take `Authorization: Bearer <prefix>.<secret>`.

```
GET    /v1/availability?service=&from=&to=[&location=][&resource=][&limit=]
POST   /v1/holds                 { customerId, serviceId, locationId, startsAt }
POST   /v1/bookings              { holdId }  |  { customerId, serviceId, ... }
GET    /v1/bookings/:id
DELETE /v1/bookings/:id          { reason?, status? }
```

Two things are unusual on purpose.

**Unavailability is typed, not empty.** `/v1/availability` returns a reason —
`closed`, `fully_booked`, `no_matching_resource` — because those lead to different next
sentences. Collapsing them into `[]` is why assistants say "no appointments available"
when the honest answer is "we're shut for the holiday".

**Failures carry alternatives.** A lost race returns

```json
{ "error": { "code": "slot_unavailable", "recoverable": true,
  "details": { "alternatives": [ { "label": "Mon 31 Aug, 11:30 AM", … } ] } } }
```

so a caller can offer another time in the same breath rather than apologising.

Send `Idempotency-Key` on writes. Retrying with the same key replays the original
response; reusing it with a different body is rejected.

## Design notes

Full rationale in [AGENTS.md](AGENTS.md). The three that shape everything:

1. **Availability is never stored.** No `isAvailable`, no nightly materialisation. It
   is computed per query from schedule rules, exceptions, and bookings.
2. **Snapshots speak, the source of truth promises.** A cached snapshot may *offer* a
   slot; only a hold placed against live data may *commit* one.
3. **Vocabulary is data, behaviour is code.** Tenants define their own exception types
   and categories. They do not define effects — `add` and `subtract` are a closed set,
   because the alternative is an unversioned rules DSL with no debugger.

Double-booking is prevented by a Postgres exclusion constraint, not by application
checks. Check-then-insert loses races, and it loses them with real customers.
