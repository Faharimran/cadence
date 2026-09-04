/**
 * Which models a tenant may choose, and what each one costs them in practice.
 *
 * One list, read by both the settings form and the agent. A second list would
 * drift, and the way it would announce itself is a tenant selecting a model that
 * the agent then refuses — visible only as that one business's conversations
 * going quiet.
 *
 * The descriptions are written for someone who runs a barber shop, not for
 * someone who follows model releases. "Cheapest per message" is a fact they can
 * act on; "200K context window" is not.
 */

export type ModelChoice = {
  id: string;
  label: string;
  blurb: string;
  /**
   * Whether this model accepts `output_config.effort`.
   *
   * Sent unconditionally it is a 400 on models that predate it, and a 400 here
   * means the reply never happens. Cheaper to carry the flag than to discover
   * which generation drew the line.
   */
  supportsEffort: boolean;
};

export const MODELS: ModelChoice[] = [
  {
    id: "claude-opus-5",
    label: "Most capable",
    blurb:
      "Best judgement, and the most reliable at multi-step bookings. The default, and the right choice unless message volume is making it expensive.",
    supportsEffort: true,
  },
  {
    id: "claude-sonnet-5",
    label: "Balanced",
    blurb:
      "Noticeably cheaper and quicker, and still handles booking well. Worth trying if you answer a lot of messages a day.",
    supportsEffort: true,
  },
  {
    id: "claude-haiku-4-5",
    label: "Fastest and cheapest",
    blurb:
      "For high volumes of simple questions — opening hours, prices, directions. It is weaker at conversations that change their mind halfway through.",
    supportsEffort: false,
  },
];

export const EFFORTS = [
  {
    id: "low",
    label: "Quick",
    blurb: "Answers fast and cheaply. Fine for straightforward questions.",
  },
  {
    id: "medium",
    label: "Balanced",
    blurb: "The default. Thinks enough to get bookings right without being slow.",
  },
  {
    id: "high",
    label: "Careful",
    blurb: "Thinks hardest. Slower and dearer — worth it if your bookings are complicated.",
  },
] as const;

export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_EFFORT = "medium";

export function isKnownModel(id: string): boolean {
  return MODELS.some((m) => m.id === id);
}

export function isKnownEffort(id: string): boolean {
  return EFFORTS.some((e) => e.id === id);
}

/**
 * What the agent should actually send, given whatever the tenant saved.
 *
 * Deliberately forgiving in one direction: a stored id we no longer recognise
 * falls back to the default rather than throwing. A model being retired is a
 * thing that happens on our schedule, and a tenant should not find out about it
 * as an outage.
 */
export function resolveModel(tenant: { agentModel: string | null; agentEffort: string | null }): {
  model: string;
  effort?: "low" | "medium" | "high";
} {
  const chosen = MODELS.find((m) => m.id === tenant.agentModel);
  const model = chosen ?? MODELS.find((m) => m.id === DEFAULT_MODEL)!;

  if (!model.supportsEffort) return { model: model.id };

  const effort =
    tenant.agentEffort && isKnownEffort(tenant.agentEffort)
      ? (tenant.agentEffort as "low" | "medium" | "high")
      : DEFAULT_EFFORT;

  return { model: model.id, effort };
}
