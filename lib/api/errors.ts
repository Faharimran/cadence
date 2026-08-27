/**
 * One error shape for the whole API.
 *
 * These are designed to be read by an AI agent as much as by a human developer.
 * An agent that receives a bare 409 can only apologise; an agent that receives
 * `{ code: "slot_unavailable", details: { alternatives: [...] } }` can say "that
 * one just went — Friday 11am instead?" and keep the conversation alive. Every
 * failure a caller might reasonably recover from therefore carries the material
 * needed to recover.
 */

export type CadenceErrorCode =
  // ── caller/auth ──
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "rate_limited"
  | "idempotency_mismatch"
  // ── scheduling, recoverable ──
  | "slot_unavailable"
  | "closed"
  | "hold_expired"
  | "no_matching_resource"
  // ── platform ──
  | "capability_unavailable"
  | "upstream_unavailable"
  | "internal";

const STATUS: Record<CadenceErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  rate_limited: 429,
  idempotency_mismatch: 422,
  slot_unavailable: 409,
  closed: 409,
  hold_expired: 410,
  no_matching_resource: 409,
  capability_unavailable: 501,
  upstream_unavailable: 503,
  internal: 500,
};

/**
 * Whether a caller can sensibly try something else. The conversation layer keys
 * off this to decide between "offer an alternative" and "escalate to a human".
 */
const RECOVERABLE: ReadonlySet<CadenceErrorCode> = new Set<CadenceErrorCode>([
  "slot_unavailable",
  "closed",
  "hold_expired",
  "no_matching_resource",
  "rate_limited",
  "upstream_unavailable",
]);

export class CadenceError extends Error {
  readonly code: CadenceErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: CadenceErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CadenceError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }

  get recoverable(): boolean {
    return RECOVERABLE.has(this.code);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        recoverable: this.recoverable,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

/** Postgres error codes we translate into recoverable domain errors. */
const PG_EXCLUSION_VIOLATION = "23P01";
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Turns the exclusion-constraint violation raised by the database's
 * no-double-booking guard into a recoverable domain error.
 *
 * This is the payoff of enforcing overlap in Postgres rather than in a
 * check-then-insert: the loser of a race gets a clean, typed, recoverable
 * failure instead of a silently duplicated booking.
 */
const OVERLAP_CONSTRAINT = "booking_resource_no_overlap";

export function translateDatabaseError(err: unknown): CadenceError | null {
  const code = (err as { code?: string } | null)?.code;
  const meta = (err as { meta?: { constraint?: string } } | null)?.meta;
  const constraint = meta?.constraint ?? "";

  // Prisma does not map exclusion-constraint violations, so they surface as
  // PrismaClientUnknownRequestError with the SQLSTATE buried in the message
  // rather than exposed on `code`. Checking only the structured fields catches
  // the error most of the time and misses it exactly when it matters — under the
  // concurrency this constraint exists to handle.
  const message = err instanceof Error ? err.message : String(err ?? "");

  const isOverlap =
    code === PG_EXCLUSION_VIOLATION ||
    constraint === OVERLAP_CONSTRAINT ||
    message.includes(OVERLAP_CONSTRAINT) ||
    (message.includes(PG_EXCLUSION_VIOLATION) && message.includes("exclusion constraint"));

  if (isOverlap) {
    return new CadenceError(
      "slot_unavailable",
      "That time was taken while you were confirming it.",
    );
  }
  if (code === PG_UNIQUE_VIOLATION || code === "P2002") {
    return new CadenceError("slot_unavailable", "That time is no longer available.");
  }
  return null;
}

export function isCadenceError(err: unknown): err is CadenceError {
  return err instanceof CadenceError;
}
