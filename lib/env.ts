import { z } from "zod";

/**
 * Environment is validated once, at import, and fails loudly. A scheduling
 * system that boots with a missing DATABASE_APP_URL would run every query as the
 * owner and silently disable tenant isolation — that must not be a runtime
 * discovery.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  /// Optional in local dev only. Its absence is reported by isolationEnforced()
  /// rather than crashing, so `prisma db push` on a fresh clone still works.
  DATABASE_APP_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379/1"),
  ANTHROPIC_API_KEY: z.string().optional(),
  /**
   * Required when ANTHROPIC_API_KEY is an *identity-linked* key — those keys
   * belong to a person rather than a workspace, so every request must name the
   * workspace it acts in or the API returns 400. Plain workspace-scoped keys
   * don't need it, hence optional.
   */
  ANTHROPIC_WORKSPACE_ID: z.string().optional(),
  CADENCE_SECRET: z.string().min(1),
  CADENCE_BASE_URL: z.string().url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment:\n${issues}`);
}

export const env = parsed.data;

/**
 * True when the application is configured to connect as a role that row-level
 * security actually applies to. False means policies exist but are inert.
 */
export function isolationEnforced(): boolean {
  return Boolean(env.DATABASE_APP_URL && env.DATABASE_APP_URL !== env.DATABASE_URL);
}

if (env.NODE_ENV === "production" && !isolationEnforced()) {
  throw new Error(
    "DATABASE_APP_URL must be set to a non-owner role in production — " +
      "otherwise Postgres bypasses every row-level security policy.",
  );
}
