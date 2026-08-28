import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { TenantDb } from "@/lib/prisma";
import { CadenceError, isCadenceError } from "@/lib/api/errors";
import { getAvailability } from "@/lib/engine/availability";
import { holdSlot, confirmHold, cancelBooking } from "@/lib/engine/booking";
import { describeInstant } from "@/lib/engine/time";
import { isHosted, type CapabilitySet } from "@/lib/conversation/capabilities";
import { invalidateSnapshot, type ConversationSnapshot } from "@/lib/conversation/snapshot";

/**
 * The agent's hands.
 *
 * Three principles run through every tool here:
 *
 *  1. **The toolset is assembled from the tenant's capabilities.** A business
 *     without `booking_write` gets no booking tool. Removing the capability is a
 *     harder guarantee than instructing a model not to use it — you cannot call
 *     a function that was never passed.
 *
 *  2. **Talking reads the snapshot; committing reads live.** Listing services or
 *     offers is served from cache. Availability, holds and confirmations always
 *     hit the database, because the gap between "3pm is free" and "yes please"
 *     is exactly where double-bookings are born.
 *
 *  3. **Failures are conversational.** A tool that cannot do the thing returns a
 *     recoverable result carrying alternatives, so the agent says "that just
 *     went — 11:30 instead?" rather than apologising or, worse, inventing.
 */

export type ToolContext = {
  db: TenantDb;
  caps: CapabilitySet;
  tenantId: string;
  conversationId: string;
  customerId: string;
  snapshot: ConversationSnapshot;
  /** Set by escalate_to_human so the caller knows to stop the bot on this thread. */
  outcome: { escalated: boolean; escalationReasons: string[]; bookingIds: string[] };
};

/** Every tool answers in this shape so the model can branch without guessing. */
type ToolResult =
  | { ok: true; [k: string]: unknown }
  | { ok: false; reason: string; message: string; recoverable: boolean; [k: string]: unknown };

/**
 * The SDK requires a tool to resolve to a string, so every structured result
 * goes through here. Serialising in ONE place means no tool can accidentally
 * return a bare object and fail at runtime instead of at compile time.
 */
function json(result: ToolResult): string {
  return JSON.stringify(result);
}

function fail(err: unknown): ToolResult {
  if (isCadenceError(err)) {
    return {
      ok: false,
      reason: err.code,
      message: err.message,
      recoverable: err.recoverable,
      ...(err.details ? { details: err.details } : {}),
    };
  }
  // Never surface an internal message to a model that may repeat it verbatim to
  // a customer.
  return {
    ok: false,
    reason: "internal",
    message: "That didn't work. Offer to have a colleague follow up.",
    recoverable: false,
  };
}

const IsoInstant = z
  .string()
  .describe("An ISO-8601 instant with offset, e.g. 2026-09-01T09:00:00+01:00");

function parseInstant(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new CadenceError("validation_failed", `'${field}' is not a valid ISO-8601 instant.`);
  }
  return d;
}

/** Refuses every action for a customer who has opted out of contact. */
function assertContactable(ctx: ToolContext) {
  if (ctx.snapshot.customer?.data.optedOut) {
    throw new CadenceError("forbidden", "This customer has opted out of contact.");
  }
}

/**
 * Once a thread has been escalated it belongs to a person, and the agent must
 * not keep acting on it.
 *
 * This is enforced here rather than by breaking out of the agent's loop:
 * abandoning the tool-runner's async iterator mid-flight leaves its completion
 * promise unresolved and hangs the turn. Refusing at the tool boundary gives
 * the same guarantee — the model can still emit a closing sentence, but it
 * cannot *do* anything further.
 */
function assertNotEscalated(ctx: ToolContext) {
  if (ctx.outcome.escalated) {
    throw new CadenceError(
      "forbidden",
      "This conversation has been handed to a colleague. Say one short line confirming that, and stop.",
    );
  }
}

export function buildTools(ctx: ToolContext) {
  const tools = [];

  // ── Catalog ────────────────────────────────────────────────────────
  if (ctx.caps.has("catalog")) {
    tools.push(
      betaZodTool({
        name: "list_services",
        description:
          "List what this business offers, with durations and — only where the business permits quoting one — a price. " +
          "Served from a short-lived cache, so it is fast and works even if the source system is slow. " +
          "A service with no price listed must NOT be given a price: say the team will confirm it.",
        inputSchema: z.object({
          category: z.string().optional().describe("Optional category filter."),
        }),
        run: async ({ category }) => {
          const all = ctx.snapshot.services?.data ?? [];
          const services = category
            ? all.filter((s) => s.category?.toLowerCase() === category.toLowerCase())
            : all;
          return json({
            ok: true,
            services,
            locations: ctx.snapshot.locations?.data ?? [],
          });
        },
      }),
    );
  }

  // ── Availability ───────────────────────────────────────────────────
  if (ctx.caps.has("availability")) {
    tools.push(
      betaZodTool({
        name: "check_availability",
        description:
          "Find bookable times for a service in a date range. Always reflects live data. " +
          "When nothing is available the result explains WHY, and the reasons need different replies: " +
          "'closed' means the business is shut then (say when it reopens, do not offer to keep looking); " +
          "'fully_booked' means try another day; " +
          "'no_matching_resource' means nobody here does this — escalate instead of retrying.",
        inputSchema: z.object({
          serviceId: z.string().describe("From list_services."),
          from: IsoInstant,
          to: IsoInstant,
          locationId: z.string().optional(),
          limit: z.number().int().min(1).max(20).optional(),
        }),
        run: async (input) => {
          try {
            assertNotEscalated(ctx);
            const result = await getAvailability(ctx.db, {
              tenantId: ctx.tenantId,
              serviceId: input.serviceId,
              locationId: input.locationId,
              from: parseInstant(input.from, "from"),
              to: parseInstant(input.to, "to"),
              limit: input.limit ?? 6,
            });

            if (!result.available) {
              return json({
                ok: false,
                reason: result.reason,
                message:
                  result.publicNote ??
                  (result.reason === "fully_booked"
                    ? "Nothing free in that range."
                    : "Not bookable in that range."),
                recoverable: result.reason !== "no_matching_resource",
                ...(result.nextOpenAt ? { reopensAt: result.nextOpenAt.toISOString() } : {}),
              });
            }

            return json({
              ok: true,
              slots: result.slots.map((s) => ({
                startsAt: s.startsAt.toISOString(),
                // Pre-rendered in the LOCATION's timezone. The model must quote
                // this string rather than formatting the instant itself, or a
                // Dubai customer gets told a London time.
                label: s.label,
                locationId: s.locationId,
                locationName: s.locationName,
                with: s.resourceNames.join(" + "),
              })),
            });
          } catch (err) {
            return json(fail(err));
          }
        },
      }),
    );
  }

  // ── Booking ────────────────────────────────────────────────────────
  if (ctx.caps.has("booking_write")) {
    tools.push(
      betaZodTool({
        name: "hold_slot",
        description:
          "Reserve a time for a few minutes while the customer confirms. Call this BEFORE telling them a time is theirs — " +
          "availability is advisory until held. If it fails with 'slot_unavailable' the result carries alternative times: " +
          "offer one of those in the same reply rather than apologising.",
        inputSchema: z.object({
          serviceId: z.string(),
          locationId: z.string(),
          startsAt: IsoInstant.describe("Exactly the startsAt from check_availability."),
        }),
        run: async (input) => {
          try {
            assertNotEscalated(ctx);
            assertContactable(ctx);
            if (!isHosted(ctx.caps, "booking_write")) {
              // Brokered writes must go through the connector, or our copy and
              // the tenant's real calendar diverge — and theirs is the one the
              // customer turns up for.
              throw new CadenceError(
                "capability_unavailable",
                "Booking is handled by the business's own system; a colleague will confirm.",
              );
            }

            const held = await holdSlot(ctx.db, {
              tenantId: ctx.tenantId,
              customerId: ctx.customerId,
              serviceId: input.serviceId,
              locationId: input.locationId,
              startsAt: parseInstant(input.startsAt, "startsAt"),
              source: "agent",
            });

            ctx.outcome.bookingIds.push(held.bookingId);
            return json({
              ok: true,
              holdId: held.bookingId,
              label: held.label,
              expiresAt: held.expiresAt.toISOString(),
              location: held.locationName,
              with: held.resourceNames.join(" + "),
            });
          } catch (err) {
            return json(fail(err));
          }
        },
      }),

      betaZodTool({
        name: "confirm_booking",
        description:
          "Turn a hold into a confirmed booking, once the customer has said yes. " +
          "If it fails with 'hold_expired' the reservation lapsed — check availability again and re-offer.",
        inputSchema: z.object({ holdId: z.string() }),
        run: async ({ holdId }) => {
          try {
            assertNotEscalated(ctx);
            assertContactable(ctx);
            const booking = await confirmHold(ctx.db, {
              tenantId: ctx.tenantId,
              bookingId: holdId,
            });
            await invalidateSnapshot(ctx.conversationId);
            return json({
              ok: true,
              bookingId: booking.id,
              status: booking.status,
              startsAt: booking.startsAt.toISOString(),
            });
          } catch (err) {
            return json(fail(err));
          }
        },
      }),

      betaZodTool({
        name: "cancel_booking",
        description:
          "Cancel an existing booking at the customer's request. Only ever call this when they have clearly asked to cancel.",
        inputSchema: z.object({
          bookingId: z.string(),
          reason: z.string().max(300).optional(),
        }),
        run: async ({ bookingId, reason }) => {
          try {
            assertNotEscalated(ctx);
            const booking = await cancelBooking(ctx.db, {
              tenantId: ctx.tenantId,
              bookingId,
              reason: reason ?? "customer request",
            });
            await invalidateSnapshot(ctx.conversationId);
            return json({ ok: true, bookingId: booking.id, status: booking.status });
          } catch (err) {
            return json(fail(err));
          }
        },
      }),
    );
  }

  // ── Existing bookings ──────────────────────────────────────────────
  if (ctx.caps.has("booking_read")) {
    tools.push(
      betaZodTool({
        name: "list_my_bookings",
        description: "The customer's upcoming bookings, with times already rendered in the right timezone.",
        inputSchema: z.object({}),
        run: async () => {
          const upcoming = ctx.snapshot.customer?.data.upcoming ?? [];
          const locations = new Map(
            (ctx.snapshot.locations?.data ?? []).map((l) => [l.name, l.timezone]),
          );
          return json({
            ok: true,
            bookings: upcoming.map((b) => ({
              ...b,
              label: describeInstant(
                new Date(b.startsAt),
                locations.get(b.locationName) ?? "UTC",
              ),
            })),
          });
        },
      }),
    );
  }

  // ── Offers ─────────────────────────────────────────────────────────
  if (ctx.caps.has("promotions")) {
    tools.push(
      betaZodTool({
        name: "list_offers",
        description:
          "Promotions running right now. Only mention an offer using the wording given here. " +
          "If an offer has no description, say one is running and that a colleague will explain the terms — " +
          "never describe or calculate a discount yourself.",
        inputSchema: z.object({}),
        run: async () =>
          json({ ok: true, offers: ctx.snapshot.offers?.data ?? [] }),
      }),
    );
  }

  // ── Escalation — always available ──────────────────────────────────
  tools.push(
    betaZodTool({
      name: "escalate_to_human",
      description:
        "Hand this conversation to a person and stop replying. Use when the customer asks for a human, is upset, " +
        "asks something clinical or contractual you should not answer, negotiates on price, or when a tool has failed " +
        "in a way you cannot work around. Escalating is always safer than guessing.",
      inputSchema: z.object({
        reasons: z
          .array(
            z.enum([
              "wants_human",
              "complaint",
              "out_of_scope",
              "price_negotiation",
              "tool_failure",
              "unclear_intent",
            ]),
          )
          .min(1),
        note: z.string().max(500).describe("One line for the colleague picking this up."),
      }),
      run: async ({ reasons, note }) => {
        if (ctx.outcome.escalated) {
          return json({ ok: true, escalated: true, instruction: "Already handed over. Stop." });
        }
        ctx.outcome.escalated = true;
        ctx.outcome.escalationReasons = reasons;
        await ctx.db.conversation.updateMany({
          where: { id: ctx.conversationId, tenantId: ctx.tenantId },
          data: { botPaused: true, botPausedAt: new Date() },
        });
        return json({
          ok: true,
          escalated: true,
          note,
          // Told explicitly, because a model that thinks it can keep helping
          // will keep helping.
          instruction:
            "Tell the customer a colleague will pick this up shortly, then stop. Do not attempt anything further.",
        });
      },
    }),
  );

  return tools;
}
