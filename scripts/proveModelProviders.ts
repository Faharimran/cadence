/**
 * Executable proof that a business can bring its own model key — WITHOUT
 * calling one.
 *
 * Four claims, and every one of them fails silently if it is wrong, which is
 * why they are asserted rather than trusted:
 *
 *  1. **The default is ours, and an inactive key stays out of the way.** A
 *     business that never opens the page is answered on enori's key, and one
 *     that switched back is too — with their key still saved, not deleted.
 *
 *  2. **A key is encrypted at rest and never comes back out.** The column holds
 *     ciphertext, and the summary a page renders carries four characters of it,
 *     which is enough to recognise and useless to spend.
 *
 *  3. **The toolset survives the translation.** The agent's tools are defined in
 *     Anthropic's shape; on any other provider they cross to chat-completions.
 *     A mistake there is invisible until a customer asks to book — so the real
 *     toolset is translated here and inspected, and the loop is driven end to
 *     end against a stub that answers like a provider.
 *
 *  4. **A failing key never quietly spends ours.** The rule is one function, and
 *     every combination is checked, including the one that must never happen.
 *
 * Also asserted: an address that would point enori's own server at a private
 * network is refused, and the operator console cannot read a tenant's key.
 *
 * Run: npm run prove:providers
 */
import { readFileSync } from "node:fs";
import { adminDb, withTenant } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { encrypt } from "@/lib/crypto";
import { resolveModel } from "@/lib/conversation/models";
import {
  chatCompletionsUrl,
  classifyFailure,
  failureResponse,
  getProviderSummary,
  isProviderFailure,
  resolveProvider,
  unsafeEndpointReason,
  VENDORS,
} from "@/lib/conversation/providers";
import { buildChatRequest, runOpenAiTurn, type Fetcher } from "@/lib/conversation/drivers";
import { resolveCapabilities } from "@/lib/conversation/capabilities";
import { getSnapshot, invalidateSnapshot } from "@/lib/conversation/snapshot";
import { buildTools, type ToolContext } from "@/lib/conversation/tools";
import { buildKnowledgeContext } from "@/lib/knowledge";
import { openThread } from "@/lib/conversation/thread";

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

/** Distinctive enough that finding it anywhere it should not be is conclusive. */
const PROBE_KEY = "sk-probe-zylquist-7731-verrandean";

async function clearProvider(tenantId: string) {
  await adminDb.modelProvider.deleteMany({ where: { tenantId } });
}

// ══════════════════════════════════════════════════════════════════════
//  1 · Whose key answers
// ══════════════════════════════════════════════════════════════════════

async function proveResolution(tenantId: string) {
  console.log("\nWhose key answers");

  const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const expected = resolveModel(tenant);

  await clearProvider(tenantId);
  await withTenant(tenantId, async (db) => {
    const p = await resolveProvider(db, tenantId, tenant);
    check("no key saved → enori's", p.source === "platform", p.source);
    check("on the Messages API", p.protocol === "anthropic");
    check("with the model the tenant chose", p.model === expected.model, p.model);
  });

  // Saved, then switched back to cadence. The row stays; it just stops being used.
  await adminDb.modelProvider.create({
    data: {
      tenantId,
      protocol: "openai",
      vendor: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: encrypt(PROBE_KEY),
      model: "deepseek-chat",
      active: false,
    },
  });
  await withTenant(tenantId, async (db) => {
    const p = await resolveProvider(db, tenantId, tenant);
    check("a saved-but-inactive key is not used", p.source === "platform", p.source);
    const summary = await getProviderSummary(db, tenantId);
    check("and the page still shows it as saved", summary?.active === false && summary.model === "deepseek-chat");
  });

  await adminDb.modelProvider.updateMany({ where: { tenantId }, data: { active: true } });
  await withTenant(tenantId, async (db) => {
    const p = await resolveProvider(db, tenantId, tenant);
    check("an active key wins over enori's", p.source === "tenant", p.source);
    check("on the protocol it was saved with", p.protocol === "openai", p.protocol);
    check("at the address it was saved with", p.baseUrl === "https://api.deepseek.com/v1");
    check("running the model it was saved with", p.model === "deepseek-chat", p.model);
    check(
      "and no thinking effort is sent to a protocol that has no such field",
      p.effort === undefined,
    );
    check("a key never seen to work is worth recording once", p.shouldRecordOk === true);
  });

  // ...and then is not written again on every message after it.
  await adminDb.modelProvider.updateMany({
    where: { tenantId },
    data: { lastOkAt: new Date(), lastFailureAt: null, lastFailureNote: null },
  });
  await withTenant(tenantId, async (db) => {
    const p = await resolveProvider(db, tenantId, tenant);
    check("a key known to be working is not re-recorded", p.shouldRecordOk === false);
  });

  // Unless something happened that the page is still showing.
  await adminDb.modelProvider.updateMany({
    where: { tenantId },
    data: { lastFailureAt: new Date(), lastFailureNote: "probe" },
  });
  await withTenant(tenantId, async (db) => {
    const p = await resolveProvider(db, tenantId, tenant);
    check("a key that recovers clears the failure on the next turn", p.shouldRecordOk === true);
  });

  // The claim that matters most: ANTHROPIC_API_KEY is set in this process, and
  // it still does not get used. There is no fallback path to find.
  check("enori's key is present in this environment", Boolean(process.env.ANTHROPIC_API_KEY));
}

// ══════════════════════════════════════════════════════════════════════
//  2 · The key at rest
// ══════════════════════════════════════════════════════════════════════

async function proveSecrecy(tenantId: string) {
  console.log("\nThe key at rest");

  const row = await adminDb.modelProvider.findFirstOrThrow({ where: { tenantId } });
  check("the column holds ciphertext, not the key", row.apiKey !== PROBE_KEY);
  check("written by lib/crypto", row.apiKey.startsWith("v1."));

  await withTenant(tenantId, async (db) => {
    const summary = await getProviderSummary(db, tenantId);
    const rendered = JSON.stringify(summary);
    check("what a page renders contains no part of the key", !rendered.includes("probe-zylquist"));
    check("only its last four characters", summary?.keyHint === "…dean", summary?.keyHint);
  });

  // Rule 9: the operator console reads across tenants on the owner connection,
  // where row-level security does not apply. A stored secret must not be
  // reachable from there.
  //
  // This used to be enforced as "metrics.ts never mentions modelProvider at
  // all", which was the cheapest durable guarantee right up until the console
  // had to answer a question it cannot answer any other way: whose key is this
  // business on, and has it stopped working? That is operational fact, not
  // credential — and refusing to load the row meant an operator learned a
  // tenant's key had died from the tenant.
  //
  // So the guarantee is narrowed rather than dropped, to the two things that
  // would actually turn a console into a key vault:
  //
  //   1. it never SELECTS the ciphertext, so the secret never enters the
  //      process at all — not even to derive a hint from;
  //   2. it never calls `decrypt`, which is the only thing that could turn that
  //      ciphertext back into a usable key.
  //
  // Still read as source rather than exercised, for the original reason: the
  // assertion is about what the console CANNOT do, and calling it against one
  // tenant proves only that this tenant leaked nothing today. The live
  // counterpart — a real key seeded and every rendered page searched for it —
  // is in scripts/provePlatform.ts.
  const metrics = readFileSync("lib/platform/metrics.ts", "utf8");
  check(
    "the operator console never selects the stored key",
    !/apiKey\s*:\s*true/.test(metrics),
  );
  check(
    "and cannot decrypt one if it had it",
    !/\bdecrypt\b/.test(metrics),
  );

  // The other half of "never comes back out": the form that takes the key must
  // not render it again. A password input with a `value` would put the
  // plaintext in the HTML of every page load, which no amount of encryption at
  // rest would make private.
  const form = readFileSync("app/admin/settings/model/forms.tsx", "utf8");
  const start = form.indexOf('name="apiKey"');
  const field = start >= 0 ? form.slice(start, form.indexOf("/>", start)) : "";
  check("the key field exists", start >= 0);
  check("and never renders the saved key back", field.length > 0 && !/\bvalue=/.test(field));
  check("as a password field", /type="password"/.test(field));
}

// ══════════════════════════════════════════════════════════════════════
//  3 · The toolset, translated
// ══════════════════════════════════════════════════════════════════════

async function proveTranslation(tenantId: string) {
  console.log("\nThe toolset, translated");

  const thread = await withTenant(tenantId, (db) =>
    openThread(db, {
      tenantId,
      channel: "web",
      externalThreadId: `provider-probe-${Date.now()}`,
      identity: { phone: "+919812340099" },
    }),
  );

  const tools = await withTenant(tenantId, async (db) => {
    await invalidateSnapshot(thread.conversationId);
    const caps = await resolveCapabilities(db, tenantId);
    const snapshot = await getSnapshot(db, caps, {
      tenantId,
      conversationId: thread.conversationId,
      customerId: thread.customerId,
    });
    const ctx: ToolContext = {
      db,
      caps,
      snapshot,
      knowledge: await buildKnowledgeContext(db, tenantId),
      tenantId,
      conversationId: thread.conversationId,
      customerId: thread.customerId,
      outcome: { escalated: false, escalationReasons: [], bookingIds: [], sources: [] },
    };
    return buildTools(ctx) as { name: string; description?: string; input_schema: Record<string, unknown> }[];
  });

  check("the tenant has a real toolset to translate", tools.length > 0, `${tools.length} tools`);

  const { url, headers, body } = buildChatRequest({
    system: [{ text: "STABLE BLOCK" }, { text: "VOLATILE BLOCK" }],
    messages: [{ role: "user", content: "hello" }],
    tools,
    model: "deepseek-chat",
    maxTokens: 2048,
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: PROBE_KEY,
    vendorLabel: "DeepSeek",
  });

  const messages = body.messages as { role: string; content: string }[];
  check("the address gains the chat-completions path", url === "https://api.deepseek.com/v1/chat/completions", url);
  check(
    "appending it twice is not possible",
    chatCompletionsUrl(url) === url && chatCompletionsUrl("https://x.test/v1/") === "https://x.test/v1/chat/completions",
  );
  check("the key travels as a bearer token", headers.authorization === `Bearer ${PROBE_KEY}`);
  check("both prompt blocks become one system message", messages[0].role === "system");
  check(
    "and neither block is lost",
    messages[0].content.includes("STABLE BLOCK") && messages[0].content.includes("VOLATILE BLOCK"),
  );

  const serialised = JSON.stringify(body);
  check("no cache_control reaches a protocol that has no such field", !serialised.includes("cache_control"));
  check("no $schema reaches a provider that would reject it", !serialised.includes("$schema"));
  check("streaming is asked for explicitly, and off", body.stream === false);
  check("the model may choose its own tools", body.tool_choice === "auto");

  const sent = body.tools as { type: string; function: { name: string; description: string; parameters: { type?: string } } }[];
  check("every tool crossed", sent.length === tools.length, `${sent.length} of ${tools.length}`);
  check(
    "each as a function with a JSON Schema",
    sent.every((t) => t.type === "function" && t.function.name && t.function.parameters?.type === "object"),
  );
  check(
    "each keeping the description the model reads",
    sent.every((t) => t.function.description.length > 20),
  );

  await adminDb.conversationMessage.deleteMany({ where: { conversationId: thread.conversationId } });
  await adminDb.conversation.deleteMany({ where: { id: thread.conversationId } });
  await adminDb.customer.deleteMany({ where: { id: thread.customerId } });
}

// ══════════════════════════════════════════════════════════════════════
//  4 · The loop, against a provider that answers
// ══════════════════════════════════════════════════════════════════════

/** A tool in the shape the driver reads, that records being run. */
function stubTool(ran: unknown[]) {
  return {
    name: "check_availability",
    description: "Find times that could be booked, for a service on a day.",
    input_schema: {
      type: "object",
      properties: { day: { type: "string" } },
      required: ["day"],
      additionalProperties: false,
    },
    parse: (input: unknown) => {
      const value = input as { day?: unknown };
      if (typeof value.day !== "string") throw new Error("'day' is required");
      return value;
    },
    run: (input: unknown) => {
      ran.push(input);
      return JSON.stringify({ ok: true, slots: ["10:00", "10:30"] });
    },
  };
}

function reply(body: unknown, usage: { prompt_tokens: number; completion_tokens: number }) {
  return new Response(JSON.stringify({ ...(body as object), usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function proveLoop() {
  console.log("\nThe loop, against a provider that answers");

  const ran: unknown[] = [];
  const sentBodies: Record<string, unknown>[] = [];

  const fetcher: Fetcher = async (_url, init) => {
    sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);

    // First answer: call the tool. Second: the reply itself.
    if (sentBodies.length === 1) {
      return reply(
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "Let me check that for you.",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "check_availability", arguments: '{"day":"Friday"}' },
                  },
                ],
              },
            },
          ],
        },
        { prompt_tokens: 100, completion_tokens: 10 },
      );
    }
    return reply(
      { choices: [{ finish_reason: "stop", message: { content: "Friday's open — 10 or 10:30?" } }] },
      { prompt_tokens: 140, completion_tokens: 12 },
    );
  };

  const turn = await runOpenAiTurn(
    {
      protocol: "openai",
      system: [{ type: "text", text: "You are the assistant." }],
      messages: [{ role: "user", content: "any chance of Friday?" }],
      tools: [stubTool(ran)] as never,
      model: "deepseek-chat",
      maxIterations: 12,
      maxTokens: 2048,
      apiKey: PROBE_KEY,
      baseUrl: "https://api.deepseek.com/v1",
      source: "tenant",
      vendorLabel: "DeepSeek",
    },
    fetcher,
  );

  check("the tool actually ran", ran.length === 1);
  check("with the arguments the model sent", JSON.stringify(ran[0]) === '{"day":"Friday"}');

  const second = sentBodies[1]?.messages as { role: string; content?: string }[] | undefined;
  const toolMessage = second?.find((m) => m.role === "tool");
  check("the result was posted back to the model", Boolean(toolMessage));
  check("verbatim", toolMessage?.content?.includes('"slots"') === true);
  check(
    "after the assistant turn that asked for it",
    second?.some((m) => m.role === "assistant") === true,
  );

  check("the reply is the final message", turn.text === "Friday's open — 10 or 10:30?", turn.text);
  check(
    "not the narration alongside the tool call",
    !turn.text.includes("Let me check"),
  );
  check("both round trips are counted", turn.roundTrips === 2, String(turn.roundTrips));
  check(
    "and usage is summed across them, not read off the last",
    turn.usage.input === 240 && turn.usage.output === 22,
    JSON.stringify(turn.usage),
  );
  check("the tool call is on the trace", turn.toolCalls[0]?.name === "check_availability");
}

// ══════════════════════════════════════════════════════════════════════
//  5 · When the key stops working
// ══════════════════════════════════════════════════════════════════════

async function proveFailure() {
  console.log("\nWhen the key stops working");

  const cases: [number, string, "credential" | "transient"][] = [
    [401, '{"error":{"message":"Invalid API key"}}', "credential"],
    [403, "{}", "credential"],
    [402, '{"error":{"message":"Insufficient Balance"}}', "credential"],
    [404, "{}", "credential"],
    [400, '{"error":{"message":"Model not found"}}', "credential"],
    [429, "{}", "transient"],
    [500, "", "transient"],
    [503, "", "transient"],
  ];
  for (const [status, body, kind] of cases) {
    check(`HTTP ${status} is ${kind}`, classifyFailure(status, body, "DeepSeek").kind === kind);
  }

  check(
    "and the provider's own words are passed on",
    classifyFailure(401, '{"error":{"message":"Invalid API key"}}', "DeepSeek").note.includes(
      "Invalid API key",
    ),
  );
  check(
    "but an HTML error page is not",
    !classifyFailure(502, "<html><body>Bad gateway</body></html>", "DeepSeek").note.includes("<"),
  );

  // The rule the whole feature turns on.
  check("a tenant's dead key hands the thread over", failureResponse("tenant", "credential") === "escalate");
  check("a tenant's rate limit is simply retried", failureResponse("tenant", "transient") === "retry");
  check(
    "OUR outage never pauses a tenant's threads",
    failureResponse("platform", "credential") === "retry" &&
      failureResponse("platform", "transient") === "retry",
  );

  // End to end, through the driver: a rejected key throws the classified
  // failure rather than anything the agent would mistake for a reply.
  const rejecting: Fetcher = async () =>
    new Response('{"error":{"message":"Authentication Fails"}}', {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  let thrown: unknown;
  try {
    await runOpenAiTurn(
      {
        protocol: "openai",
        system: [{ type: "text", text: "x" }],
        messages: [{ role: "user", content: "hello" }],
        tools: [] as never,
        model: "deepseek-chat",
        maxIterations: 12,
        maxTokens: 2048,
        apiKey: "revoked",
        baseUrl: "https://api.deepseek.com/v1",
        source: "tenant",
        vendorLabel: "DeepSeek",
      },
      rejecting,
    );
  } catch (err) {
    thrown = err;
  }
  check("a rejected key throws a classified failure", isProviderFailure(thrown));
  check(
    "of the kind that hands over rather than retries",
    isProviderFailure(thrown) && failureResponse("tenant", thrown.kind) === "escalate",
  );
}

// ══════════════════════════════════════════════════════════════════════
//  6 · Where we are willing to send a key
// ══════════════════════════════════════════════════════════════════════

function proveEndpointSafety() {
  console.log("\nWhere we are willing to send a key");

  const refused = [
    "http://api.deepseek.com/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/v1",
    "https://192.168.1.10/v1",
    "https://172.20.0.4/v1",
    "https://127.0.0.1/v1",
    "https://localhost/v1",
    "https://metadata.google.internal/v1",
    "not a url at all",
  ];
  for (const url of refused) {
    check(`refused: ${url}`, unsafeEndpointReason(url) !== null);
  }

  for (const vendor of VENDORS) {
    if (!vendor.baseUrl) continue;
    check(`allowed: ${vendor.baseUrl}`, unsafeEndpointReason(vendor.baseUrl) === null);
  }

  check(
    "every preset speaks a protocol we have a driver for",
    VENDORS.every((v) => v.protocol === "anthropic" || v.protocol === "openai"),
  );
  check(
    "and only 'anything else' asks a business for an address",
    VENDORS.filter((v) => v.customBaseUrl).length === 1,
  );
}

async function main() {
  const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { slug: "demo-studio" } });

  try {
    await proveResolution(tenant.id);
    await proveSecrecy(tenant.id);
    await proveTranslation(tenant.id);
    await proveLoop();
    await proveFailure();
    proveEndpointSafety();
  } finally {
    // The demo tenant answers real visitors. Leaving a probe key on it would
    // point the public demo at an endpoint that does not exist.
    await clearProvider(tenant.id);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    // Both connections must be closed or the process hangs: ioredis keeps the
    // event loop alive indefinitely.
    await adminDb.$disconnect();
    redis.disconnect();
  });
