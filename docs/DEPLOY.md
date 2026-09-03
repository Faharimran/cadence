# Deploying cadence to Railway

About an hour, once. After it, the WhatsApp webhook address stops changing —
which is the reason for doing it. Every failure during local testing traced back
to a temporary tunnel dying and taking Meta's configuration with it.

## What you are building

Four things in one Railway project:

| | What |
|---|---|
| **Postgres** | Railway plugin |
| **Redis** | Railway plugin — the queue and the conversation snapshots |
| **web** | this repo, `npm run start:web` |
| **worker** | this repo again, `npm run start:worker` |

`web` and `worker` are the same code deployed twice with different start
commands. The worker runs agent turns, reads uploaded documents and delivers
webhooks; without it messages are received and never answered.

---

## 1. Create the project

Railway → **New Project** → **Deploy from GitHub repo** → `Faharimran/cadence`.

Add **Postgres** and **Redis** from *New → Database*.

## 2. The two database roles

This is the step with a real consequence, so it is worth understanding rather
than pasting.

Every tenant-scoped table is protected by row-level security. Postgres exempts a
table's **owner** from its own policies — so an application connected as the
owner has isolation that appears configured and does nothing. cadence therefore
uses two connections: the owner for migrations, and a restricted role for
everything the app does. `lib/env.ts` refuses to boot in production unless the
two differ.

From your machine, pointed at the Railway database:

```bash
DATABASE_URL="<Railway Postgres connection string>" \
  npx tsx scripts/bootstrapAppRole.ts "<a long random password>"
```

It prints the `DATABASE_APP_URL` to set. Keep the password; you will not see it
again.

## 3. Environment variables

Set these on **both** services. Railway's `${{Postgres.DATABASE_URL}}` and
`${{Redis.REDIS_URL}}` reference the plugins.

```
DATABASE_URL          ${{Postgres.DATABASE_URL}}
DATABASE_APP_URL      <printed by the script above>
REDIS_URL             ${{Redis.REDIS_URL}}

ANTHROPIC_API_KEY     sk-ant-…
CADENCE_SECRET        <openssl rand -base64 48>
CADENCE_ENCRYPTION_KEY <openssl rand -base64 48>   # different from the above
CADENCE_BASE_URL      https://<your-app>.up.railway.app
CADENCE_SIGNUP_OPEN   false
NODE_ENV              production
```

Two of these matter more than they look:

- **`CADENCE_SECRET` and `CADENCE_ENCRYPTION_KEY` must differ.** One signs
  sessions and API keys; the other encrypts stored third-party credentials.
  Rotating the first only forces re-issuing keys; rotating the second makes
  every stored credential unreadable. They rotate on different schedules, so
  they are different secrets.
- **`CADENCE_SIGNUP_OPEN=false`** unless you actually want anyone to be able to
  create a business. `/signup` 404s when it is off.

## 4. Migrations

Set a **pre-deploy command** on the `web` service:

```
npm run deploy:migrate
```

That runs `prisma migrate deploy` and then `scripts/applyRls.ts`, which applies
the row-level-security policies, the no-double-booking exclusion constraint, and
the knowledge full-text index. **Prisma does not know those exist**, so skipping
the second half leaves a database that migrates cleanly and has no tenant
isolation.

## 5. The worker

New service → same repo → change the start command to:

```
npm run start:worker
```

Same environment variables. No health check — it serves no HTTP.

## 6. First operator and first business

From your machine, pointed at the Railway database:

```bash
DATABASE_URL="…" npx tsx scripts/createPlatformUser.ts you@example.com "<password>" admin
```

Then sign in at `/platform/signin`. Create the business itself through
`/signup` (temporarily setting `CADENCE_SIGNUP_OPEN=true`), or seed one with
`scripts/seedCaraTenant.ts`.

## 7. Point Meta at it, once

```
https://<your-app>.up.railway.app/api/webhooks/whatsapp
```

The verify token is shown on **Settings → WhatsApp**. This is the address that
now stops changing.

---

## Checking it worked

```bash
curl https://<your-app>.up.railway.app/api/health
```

```json
{"status":"ok","checks":{"database":"ok","tenantIsolation":"enforced","overlapConstraint":"present"}}
```

`tenantIsolation: enforced` is the one to read. If it says anything else, the
app is connected as the database owner and every row-level-security policy is
inert — fix that before putting a customer on it.

To prove it rather than trust it:

```bash
DATABASE_URL="…" DATABASE_APP_URL="…" npx tsx scripts/applyRls.ts --verify
```

That refuses if the app role turns out to be superuser or `BYPASSRLS`.

## Notes

- **Redis is not a cache here.** It holds the BullMQ queues and the debounce
  window. Losing it loses in-flight turns, not just speed.
- **One worker is enough** to start. The agent queue is concurrency-limited and
  the exclusion constraint makes double-booking impossible regardless, so a
  second worker is safe when volume needs it.
- **Uploaded PDFs pass through Redis** with a one-hour TTL and are never written
  to disk, so the web service needs no persistent volume.
