/**
 * Proves outbound webhooks, against a real HTTP receiver.
 *
 * The receiver verifies signatures exactly as a customer's server would, using
 * the same `verifyPayload` the docs show. If signing and verification ever
 * disagree, this fails — which a test that re-implemented the check itself
 * would not catch.
 *
 * No dev server needed; this drives the outbox directly.
 * Run: npm run prove:delivery
 */
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { adminDb, withTenant } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { recordEvent } from "@/lib/events";
import { attemptDelivery, dueDeliveries, newSigningSecret, verifyPayload } from "@/lib/webhooks/deliver";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

type Received = { event: string; verified: boolean; deliveryId: string; attempt: string };

/** A stand-in for the customer's server. `failTimes` makes it 500 on demand. */
function receiver(secret: string) {
  const received: Received[] = [];
  let failTimes = 0;

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const verified = verifyPayload(secret, req.headers["cadence-signature"] as string, raw);
      received.push({
        event: String(req.headers["cadence-event"] ?? ""),
        verified,
        deliveryId: String(req.headers["cadence-delivery"] ?? ""),
        attempt: String(req.headers["cadence-attempt"] ?? ""),
      });

      if (failTimes > 0) {
        failTimes--;
        res.writeHead(500).end("nope");
        return;
      }
      res.writeHead(200).end("ok");
    });
  });

  return {
    received,
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve((server.address() as { port: number }).port);
        });
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
    failNext: (n: number) => {
      failTimes = n;
    },
  };
}

/** Drives the drain loop the worker runs, ignoring backoff waits. */
async function drain(rounds = 1) {
  for (let i = 0; i < rounds; i++) {
    const ids = await dueDeliveries();
    for (const id of ids) await attemptDelivery(id);
  }
}

async function main() {
  const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { slug: "demo-studio" } });
  const t = tenant.id;

  await adminDb.webhookDelivery.deleteMany({ where: { tenantId: t } });
  await adminDb.webhookEndpoint.deleteMany({ where: { tenantId: t } });

  const secret = newSigningSecret();
  const server = receiver(secret);
  const port = await server.listen();

  const endpoint = await adminDb.webhookEndpoint.create({
    data: { tenantId: t, url: `http://127.0.0.1:${port}/hook`, secret, events: [] },
  });

  try {
    // ── 1. Emission ───────────────────────────────────────────────────
    console.log("\n1. Events are written as an outbox");
    await withTenant(t, (db) =>
      recordEvent(db, t, "booking.created", { bookingId: "b1", status: "held" }),
    );
    const queued = await adminDb.webhookDelivery.findMany({ where: { tenantId: t } });
    check("a delivery row is written", queued.length === 1, `${queued.length}`);
    check("pending until a worker sends it", queued[0]?.status === "pending");
    check("nothing has been sent yet", server.received.length === 0);

    // ── 2. Delivery + signature ───────────────────────────────────────
    console.log("\n2. Delivery, signed");
    await drain();
    check("the receiver got it", server.received.length === 1);
    check("the signature verifies", server.received[0]?.verified === true);
    check("the event name is in a header", server.received[0]?.event === "booking.created");

    const after = await adminDb.webhookDelivery.findFirst({ where: { tenantId: t } });
    check("and it is marked delivered", after?.status === "delivered");
    check("with a delivery timestamp", after?.deliveredAt !== null);

    // ── 3. Tampering ──────────────────────────────────────────────────
    console.log("\n3. A forged payload does not verify");
    const body = JSON.stringify({ event: "booking.created", data: { bookingId: "forged" } });
    const ts = Math.floor(Date.now() / 1000);
    check(
      "a wrong secret is rejected",
      !verifyPayload(secret, `t=${ts},v1=${"0".repeat(64)}`, body),
    );
    check("a missing signature is rejected", !verifyPayload(secret, null, body));
    check(
      "an old timestamp is rejected even with a valid signature",
      !verifyPayload(
        secret,
        `t=${ts - 3600},v1=${createHmac("sha256", secret)
          .update(`${ts - 3600}.${body}`)
          .digest("hex")}`,
        body,
      ),
      "replay protection",
    );

    // ── 4. Retries ────────────────────────────────────────────────────
    console.log("\n4. A failing endpoint is retried");
    server.received.length = 0;
    server.failNext(2);
    await withTenant(t, (db) => recordEvent(db, t, "booking.confirmed", { bookingId: "b2" }));

    await drain();
    const firstTry = await adminDb.webhookDelivery.findFirst({
      where: { tenantId: t, event: "booking.confirmed" },
    });
    check("a 500 leaves it pending, not failed", firstTry?.status === "pending");
    check("and records the error", firstTry?.lastError === "HTTP 500");

    // Backoff would make us wait 30s; rewind the clock instead of sleeping.
    for (let i = 0; i < 2; i++) {
      await adminDb.webhookDelivery.updateMany({
        where: { tenantId: t, status: "pending" },
        data: { lastAttemptAt: new Date(Date.now() - 3_600_000) },
      });
      await drain();
    }

    const eventual = await adminDb.webhookDelivery.findFirst({
      where: { tenantId: t, event: "booking.confirmed" },
    });
    check("it succeeds once the endpoint recovers", eventual?.status === "delivered");
    check("after several attempts", (eventual?.attempts ?? 0) >= 3, `${eventual?.attempts}`);
    check(
      "every attempt carried the same delivery id, so the receiver can dedupe",
      new Set(server.received.map((r) => r.deliveryId)).size === 1,
    );

    // ── 5. Giving up ──────────────────────────────────────────────────
    console.log("\n5. A dead endpoint stops being retried");
    server.failNext(99);
    await withTenant(t, (db) => recordEvent(db, t, "booking.cancelled", { bookingId: "b3" }));

    for (let i = 0; i < 6; i++) {
      await adminDb.webhookDelivery.updateMany({
        where: { tenantId: t, status: "pending" },
        data: { lastAttemptAt: new Date(Date.now() - 3_600_000) },
      });
      await drain();
    }

    const dead = await adminDb.webhookDelivery.findFirst({
      where: { tenantId: t, event: "booking.cancelled" },
    });
    check("it eventually gives up", dead?.status === "failed", dead?.status);
    check("after a bounded number of attempts", (dead?.attempts ?? 0) === 5, `${dead?.attempts}`);

    // ── 6. Subscriptions ──────────────────────────────────────────────
    console.log("\n6. Endpoints only get what they asked for");
    await adminDb.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { events: ["booking.cancelled"], active: true },
    });
    await adminDb.webhookDelivery.deleteMany({ where: { tenantId: t } });

    await withTenant(t, (db) => recordEvent(db, t, "booking.created", { bookingId: "b4" }));
    check(
      "an unsubscribed event is not queued",
      (await adminDb.webhookDelivery.count({ where: { tenantId: t } })) === 0,
    );

    await withTenant(t, (db) => recordEvent(db, t, "booking.cancelled", { bookingId: "b5" }));
    check(
      "a subscribed one is",
      (await adminDb.webhookDelivery.count({ where: { tenantId: t } })) === 1,
    );

    // ── 7. Disabled endpoints ─────────────────────────────────────────
    console.log("\n7. A disabled endpoint receives nothing");
    await adminDb.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { active: false, events: [] },
    });
    await adminDb.webhookDelivery.deleteMany({ where: { tenantId: t } });
    await withTenant(t, (db) => recordEvent(db, t, "booking.created", { bookingId: "b6" }));
    check(
      "nothing is even queued for it",
      (await adminDb.webhookDelivery.count({ where: { tenantId: t } })) === 0,
    );
  } finally {
    await server.close();
    await adminDb.webhookDelivery.deleteMany({ where: { tenantId: t } });
    await adminDb.webhookEndpoint.deleteMany({ where: { tenantId: t } });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await adminDb.$disconnect();
    redis.disconnect();
  });
