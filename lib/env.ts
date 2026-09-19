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
  /**
   * Encrypts stored third-party credentials. Kept separate from CADENCE_SECRET
   * so the two rotate independently — rotating the API-key pepper only forces
   * keys to be reissued, whereas rotating this one makes existing ciphertext
   * unreadable.
   */
  CADENCE_ENCRYPTION_KEY: z.string().min(16).optional(),
  CADENCE_BASE_URL: z.string().url().default("http://localhost:3000"),
  /**
   * Whether a tenant may point their model endpoint at a private address.
   *
   * False on a hosted deployment, and that is not a preference: the endpoint a
   * tenant saves is fetched by OUR server, so "http://169.254.169.254/…" is a
   * request to read the cloud provider's instance metadata from inside the
   * network. True only where enori runs on the same private network as the
   * model — a business hosting its own behind vLLM or Ollama, which is a real
   * deployment and the reason this is a switch rather than a rule.
   */
  CADENCE_ALLOW_PRIVATE_MODEL_ENDPOINTS: z.enum(["true", "false"]).default("false"),
  /**
   * Whether anyone may create a business at /signup. Open by default — a product
   * you cannot sign up for is a bespoke install. Set "false" on a deployment
   * that onboards customers by hand, and the route 404s.
   */
  CADENCE_SIGNUP_OPEN: z.enum(["true", "false"]).default("true"),
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

if (env.NODE_ENV === "production" && !env.CADENCE_ENCRYPTION_KEY) {
  throw new Error(
    "CADENCE_ENCRYPTION_KEY must be set in production — third-party credentials are stored " +
      "encrypted, and deriving the key from CADENCE_SECRET couples two things that need to " +
      "rotate on different schedules.",
  );
}

if (env.NODE_ENV === "production" && !isolationEnforced()) {
  throw new Error(
    "DATABASE_APP_URL must be set to a non-owner role in production — " +
      "otherwise Postgres bypasses every row-level security policy.",
  );
}
