import { createHash } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantDb } from "@/lib/prisma";
import { authenticate, requireScope, type AuthContext } from "@/lib/api/auth";
import { CadenceError, isCadenceError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

/**
 * The single entry point every v1 route goes through. It exists so that
 * authentication, tenant pinning, idempotency and error shaping cannot be
 * forgotten on an individual endpoint — the only way to write a route is to
 * write it inside this wrapper.
 */

type Ctx<TBody> = {
  auth: AuthContext;
  /** Already pinned to the caller's tenant; RLS is active on this handle. */
  db: TenantDb;
  body: TBody;
  searchParams: URLSearchParams;
  /** Dynamic route segments, already awaited (Next 16 delivers these as a Promise). */
  params: Record<string, string>;
};

/** What Next 16 passes as the second argument to a dynamic route handler. */
type RouteContext = { params: Promise<Record<string, string | string[]>> };

type Options<TSchema extends z.ZodTypeAny | undefined> = {
  scope?: "read" | "write";
  /** Zod schema for the JSON body. Omit for GET/DELETE. */
  body?: TSchema;
  /**
   * Honour the Idempotency-Key header. Only meaningful for writes; a client
   * that times out mid-POST WILL retry, and without this each retry is a second
   * booking.
   */
  idempotent?: boolean;
};

const IDEMPOTENCY_TTL_HOURS = 24;

export function route<TSchema extends z.ZodTypeAny | undefined = undefined>(
  options: Options<TSchema>,
  handler: (
    ctx: Ctx<TSchema extends z.ZodTypeAny ? z.infer<TSchema> : undefined>,
  ) => Promise<unknown>,
) {
  return async (request: Request, ctx?: RouteContext): Promise<Response> => {
    try {
      const auth = await authenticate(request);
      requireScope(auth, options.scope ?? "read");

      const url = new URL(request.url);

      // Next 16 makes params async. Collapse array segments to their first value —
      // none of the v1 routes use catch-all segments.
      const rawParams = ctx?.params ? await ctx.params : {};
      const params: Record<string, string> = Object.fromEntries(
        Object.entries(rawParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
      );

      let body: unknown = undefined;
      if (options.body) {
        const raw = await request.text();
        let parsedJson: unknown;
        try {
          parsedJson = raw ? JSON.parse(raw) : {};
        } catch {
          throw new CadenceError("validation_failed", "Body is not valid JSON.");
        }
        const result = options.body.safeParse(parsedJson);
        if (!result.success) {
          // Field-level detail, but only the parts a caller needs to fix their
          // request — never the raw Zod internals.
          throw new CadenceError("validation_failed", "Request body is invalid.", {
            fields: result.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          });
        }
        body = result.data;
      }

      const idempotencyKey = options.idempotent
        ? request.headers.get("idempotency-key")?.trim() || null
        : null;

      const requestHash = idempotencyKey
        ? createHash("sha256")
            .update(`${request.method}:${url.pathname}:${JSON.stringify(body ?? null)}`)
            .digest("hex")
        : null;

      const outcome = await withTenant(auth.tenantId, async (db) => {
        // Idempotency check and the handler's writes share one transaction. If
        // they did not, a crash between them would leave the booking committed
        // and the key unrecorded — and the client's retry would book again.
        if (idempotencyKey && requestHash) {
          const existing = await db.idempotencyRecord.findUnique({
            where: { tenantId_key: { tenantId: auth.tenantId, key: idempotencyKey } },
          });
          if (existing) {
            if (existing.requestHash !== requestHash) {
              throw new CadenceError(
                "idempotency_mismatch",
                "This Idempotency-Key was already used with a different request body.",
              );
            }
            return { status: existing.statusCode, data: existing.responseBody, replayed: true };
          }
        }

        const data = await handler({
          auth,
          db,
          body: body as never,
          searchParams: url.searchParams,
          params,
        });
        const status = request.method === "POST" ? 201 : 200;

        if (idempotencyKey && requestHash) {
          await db.idempotencyRecord.create({
            data: {
              tenantId: auth.tenantId,
              key: idempotencyKey,
              requestHash,
              statusCode: status,
              responseBody: (data ?? null) as never,
              expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3_600_000),
            },
          });
        }

        return { status, data, replayed: false };
      });

      return Response.json(outcome.data, {
        status: outcome.status,
        headers: outcome.replayed ? { "Idempotent-Replay": "true" } : undefined,
      });
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}

function toErrorResponse(err: unknown): Response {
  if (isCadenceError(err)) {
    // Client errors are expected traffic, not incidents. Only log the ones that
    // indicate something is actually wrong on our side.
    if (err.status >= 500) logger.error(err.message, { code: err.code });
    return Response.json(err.toJSON(), { status: err.status });
  }

  logger.error("Unhandled error in API route", {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  // Never leak an internal message or stack to a caller.
  return Response.json(
    new CadenceError("internal", "Something went wrong on our side.").toJSON(),
    { status: 500 },
  );
}

/** Parses an ISO-8601 instant from a query parameter. */
export function parseInstant(value: string | null, field: string): Date {
  if (!value) throw new CadenceError("validation_failed", `Missing '${field}'.`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new CadenceError("validation_failed", `'${field}' is not a valid ISO-8601 instant.`);
  }
  return d;
}
