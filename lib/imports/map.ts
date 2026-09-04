/**
 * Working out what each column in somebody's spreadsheet actually is.
 *
 * This is the only part of the import that a model does, and the reason it is
 * worth a model call is that the input is genuinely open: "Price", "Rate",
 * "Cost (₹)", "Charges", "MRP", "Amount", and a column headed "2024" that turns
 * out to hold prices. A lookup table gets the first two and fails silently on
 * the rest.
 *
 * Two things keep it honest:
 *
 *   · it decides only which column goes where, never what a value means — the
 *     cells are parsed by lib/imports/fields.ts, deterministically, so a model
 *     cannot invent a price
 *   · the answer is shown to the owner before it is stored, and stored once
 *     agreed, so a scheduled re-read never depends on a model call and the
 *     mapping cannot change under them between two syncs
 *
 * If there is no API key, or the call fails, it falls back to a name match. A
 * sheet headed "Name, Duration, Price" maps perfectly well without a model, and
 * an import that refuses to run because a model was unreachable is worse than
 * one that asks the owner to check three dropdowns.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { fieldsFor, type FieldSpec } from "./fields";

const MODEL = "claude-opus-5";

/** header → our field key. A header absent from this is ignored on import. */
export type Mapping = Record<string, string>;

const Proposal = z.object({
  columns: z.array(
    z.object({
      header: z.string().describe("The column heading, copied exactly."),
      field: z
        .string()
        .describe("Our field key this column holds, or \"ignore\" if it is not one of them."),
      confidence: z.enum(["high", "low"]),
      note: z
        .string()
        .describe("Only when confidence is low: what is uncertain, in one short phrase."),
    }),
  ),
});

export type MappingProposal = {
  mapping: Mapping;
  /** Columns the model was unsure about, for the owner to confirm first. */
  uncertain: { header: string; field: string; note: string }[];
  /** Required fields nothing was mapped to. The import cannot run with these. */
  missing: string[];
  /** Whether a model was actually consulted, or this is the name-match fallback. */
  source: "model" | "headers";
};

/**
 * Header matching for when there is no model, and as the seed the model is
 * checked against. Deliberately conservative: it matches the obvious spellings
 * and declines to guess, because a wrong confident answer here is worse than no
 * answer — no answer shows the owner a dropdown, a wrong one shows them nothing.
 */
const ALIASES: Record<string, string[]> = {
  name: ["name", "service", "service name", "treatment", "item", "description of service", "particulars"],
  category: ["category", "type", "group", "department", "section"],
  description: ["description", "details", "notes", "about"],
  durationMinutes: ["duration", "time", "minutes", "mins", "length", "duration (mins)", "time taken"],
  priceMinor: ["price", "cost", "rate", "amount", "charge", "charges", "fee", "fees", "mrp", "value"],
  bufferAfterMinutes: ["buffer", "turnaround", "cleanup", "gap", "buffer after"],
  active: ["active", "status", "available", "offered", "enabled", "in use"],
  externalId: ["id", "code", "ref", "reference", "sku", "item code", "service code", "customer id"],
  phone: ["phone", "mobile", "contact", "number", "phone number", "mobile number", "cell", "whatsapp"],
  email: ["email", "e-mail", "email address", "mail"],
};

function byHeaderName(headers: string[], fields: FieldSpec[]): Mapping {
  const allowed = new Set(fields.map((f) => f.key));
  const mapping: Mapping = {};
  const taken = new Set<string>();

  for (const header of headers) {
    const h = header.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    for (const [field, names] of Object.entries(ALIASES)) {
      if (!allowed.has(field) || taken.has(field)) continue;
      if (names.includes(h)) {
        mapping[header] = field;
        taken.add(field);
        break;
      }
    }
  }
  return mapping;
}

/**
 * Proposes a mapping for a sheet.
 *
 * `sample` should be the first handful of rows. The headings alone are often not
 * enough — a column called "Rate" could be a price or a tax rate, and the values
 * settle it — but a whole spreadsheet is both unnecessary and a lot of somebody
 * else's customer data to send anywhere.
 */
export async function proposeMapping(args: {
  kind: string;
  headers: string[];
  sample: Record<string, string>[];
  currency: string;
}): Promise<MappingProposal> {
  const fields = fieldsFor(args.kind);
  const fallback = byHeaderName(args.headers, fields);

  const finish = (mapping: Mapping, uncertain: MappingProposal["uncertain"], source: "model" | "headers") => {
    const mapped = new Set(Object.values(mapping));
    const missing = fields.filter((f) => f.required && !mapped.has(f.key)).map((f) => f.key);
    return { mapping, uncertain, missing, source };
  };

  if (!env.ANTHROPIC_API_KEY) return finish(fallback, [], "headers");

  // Five rows: enough to tell a price from a tax rate, few enough that this is
  // not a bulk transfer of someone's customer list to a model.
  const rows = args.sample.slice(0, 5);

  try {
    const client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_WORKSPACE_ID
        ? { defaultHeaders: { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } }
        : {}),
    });

    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      output_config: { format: zodOutputFormat(Proposal), effort: "low" },
      messages: [
        {
          role: "user",
          content:
            `A business is moving to new booking software and has given us a spreadsheet ` +
            `they have kept for years. Work out which column holds what.\n\n` +
            `The fields we can fill, and what each means:\n` +
            fields.map((f) => `- ${f.key} — ${f.label}. ${f.hint}`).join("\n") +
            `\n\nPrices are in ${args.currency}.\n\n` +
            `Return one entry per column, using the heading exactly as given. Use ` +
            `"ignore" for columns that are none of these — sheets like this usually ` +
            `carry working notes, totals, or a staff member's initials, and those are ` +
            `not errors, they are just not ours.\n\n` +
            `Mark confidence low whenever the heading is ambiguous and the values do ` +
            `not settle it. Low confidence is checked by a person, so it costs little; ` +
            `a confident wrong answer is applied silently, which costs a lot.\n\n` +
            `Headings: ${JSON.stringify(args.headers)}\n\n` +
            `First rows:\n${JSON.stringify(rows, null, 2)}`,
        },
      ],
    });

    const parsed = response.parsed_output;
    if (!parsed) throw new Error("no parsed output");

    const allowed = new Set(fields.map((f) => f.key));
    const known = new Set(args.headers);
    const mapping: Mapping = {};
    const uncertain: MappingProposal["uncertain"] = [];
    const taken = new Set<string>();

    for (const c of parsed.columns) {
      // A heading the model invented, or one it renamed, cannot be matched to a
      // real column and would map data from nowhere.
      if (!known.has(c.header)) continue;
      if (c.field === "ignore" || !allowed.has(c.field)) continue;
      // Two columns claiming the same field: keep the first, which is the
      // model's own ordering, and surface the loser rather than dropping it
      // silently.
      if (taken.has(c.field)) {
        uncertain.push({
          header: c.header,
          field: c.field,
          note: `Also looked like ${c.field}, which another column is already filling.`,
        });
        continue;
      }
      mapping[c.header] = c.field;
      taken.add(c.field);
      if (c.confidence === "low") {
        uncertain.push({ header: c.header, field: c.field, note: c.note || "Not sure about this one." });
      }
    }

    // Anything the header match found that the model did not is worth keeping —
    // a column literally headed "Price" is not a judgement call.
    for (const [header, field] of Object.entries(fallback)) {
      if (!mapping[header] && !taken.has(field)) {
        mapping[header] = field;
        taken.add(field);
      }
    }

    return finish(mapping, uncertain, "model");
  } catch (err) {
    logger.warn("import mapping fell back to header names", {
      err: err instanceof Error ? err.message : String(err),
      kind: args.kind,
    });
    return finish(fallback, [], "headers");
  }
}
