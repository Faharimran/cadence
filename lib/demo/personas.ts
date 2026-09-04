import type { Capability } from "@prisma/client";

/**
 * The three businesses a visitor can talk to on the public page.
 *
 * This file is the same kind of thing as `lib/presets.ts`: **data that becomes
 * ordinary rows**, read once by the seed script and then never consulted to
 * decide behaviour. Nothing here is imported by the engine, by the agent, or by
 * any tool. A demo clinic sounds clinical because `descriptor`, `toneNote` and
 * `escalationTopics` say so on its tenant row — not because the assistant knows
 * it is talking to a clinic.
 *
 * That is the whole reason a demo is worth building. Three businesses in three
 * countries, three currencies, three timezones and three sets of things they
 * refuse to discuss, all answered by one unmodified agent, is the product claim
 * stated in a form a stranger can try to break in thirty seconds.
 *
 * Two rules hold this honest:
 *
 *  1. **Every article is `approved`.** The assistant may only repeat what the
 *     business signed off, and the demo must not be the one place that is
 *     relaxed — so these are written as a real owner would have to write them,
 *     and the gaps between them are deliberate. Ask the clinic what a treatment
 *     costs beyond the listed fee and it will hand you over, on the page, in
 *     front of you.
 *
 *  2. **No capability that writes.** See `DEMO_CAPABILITIES`.
 */

export type DemoService = {
  name: string;
  category: string;
  durationMinutes: number;
  /** Minor units of the tenant's currency. Null is a real case: price on request. */
  priceMinor: number | null;
  /** Tags a resource must carry to perform it. */
  requires: string[];
};

export type DemoResource = {
  name: string;
  kind: "person" | "room" | "equipment";
  tags: string[];
};

export type DemoHours = {
  /** 0 = Sunday .. 6 = Saturday, in the location's own timezone. */
  weekdays: number[];
  /** Local wall-clock, never an instant. */
  startTime: string;
  endTime: string;
};

export type DemoPersona = {
  /** URL-safe id used by the chat endpoint. The endpoint accepts these and nothing else. */
  id: string;
  /** Tenant slug the seed writes. Prefixed so one query can find every demo tenant. */
  slug: string;
  businessName: string;

  // ── What the visitor sees before they type ────────────────────────
  /** Two or three words on the tab. */
  tab: string;
  /** The trade, in the words someone browsing would use. */
  trade: string;
  /** One line under the tab, setting up what is interesting to ask. */
  blurb: string;
  /** Openers. Chosen so one is answerable, one needs a tool, one gets handed over. */
  starters: string[];

  // ── What becomes tenant rows ──────────────────────────────────────
  timezone: string;
  currency: string;
  /** Locations carry their own zone; the demo runs one site each. */
  locationName: string;
  descriptor: string;
  toneNote: string;
  escalationTopics: string[];
  resources: DemoResource[];
  services: DemoService[];
  hours: DemoHours[];
  slotMinutes: number;
  /** Approved on seed, because a draft would leave the assistant with nothing to say. */
  articles: { title: string; body: string; tags: string[] }[];
};

/**
 * Read-only, and that is enforced by omission rather than by instruction.
 *
 * `buildTools` assembles the toolset from exactly this list, so a demo tenant
 * has no `hold_slot` and no `confirm_booking` — not a disabled one, not one
 * guarded by a flag someone can flip, but no such function in the request. A
 * stranger on the public internet therefore cannot write a row into a shared
 * calendar, and the next visitor never finds it picked over.
 *
 * `booking_write` and `promotions` are the two deliberately absent. Adding
 * either here is the one change that turns this page into an abuse surface.
 */
export const DEMO_CAPABILITIES: Capability[] = [
  "customers",
  "catalog",
  "availability",
  "knowledge",
];

/** Every demo tenant's slug starts with this — how the seed and the prove script find them. */
export const DEMO_SLUG_PREFIX = "cadence-demo-";

export const DEMO_PERSONAS: DemoPersona[] = [
  // ══════════════════════════════════════════════════════════════════
  //  Healthcare
  // ══════════════════════════════════════════════════════════════════
  {
    id: "clinic",
    slug: `${DEMO_SLUG_PREFIX}clinic`,
    businessName: "Northgate Physiotherapy",
    tab: "Healthcare",
    trade: "Physiotherapy clinic · London",
    blurb:
      "Books assessments against two physiotherapists and a treatment room. Hands over anything clinical without exception.",
    starters: [
      "what do you charge for a first appointment?",
      "anything free on saturday morning?",
      "my shoulder's been hurting for weeks — is that something you treat?",
    ],

    timezone: "Europe/London",
    currency: "GBP",
    locationName: "Northgate Clinic",
    descriptor:
      "A physiotherapy clinic taking appointments for assessments and treatment. Patients are seen by a named physiotherapist, and some appointments need the treatment room as well.",
    toneNote:
      "Write like a careful receptionist: warm, plain, never clinical. Do not reassure anyone about an outcome.",
    escalationTopics: [
      "anything clinical — symptoms, diagnosis, whether we can help with a specific problem, recovery times, exercises",
      "the total cost of a course of treatment, as opposed to the fee for one appointment",
      "anything a patient describes as urgent, severe or getting worse",
    ],
    resources: [
      { name: "Priya Raman", kind: "person", tags: ["Physiotherapist", "Senior"] },
      { name: "Tom Whitfield", kind: "person", tags: ["Physiotherapist"] },
      { name: "Treatment room", kind: "room", tags: ["Room"] },
    ],
    services: [
      {
        name: "Initial assessment",
        category: "assessment",
        durationMinutes: 45,
        priceMinor: 6500,
        requires: ["Physiotherapist"],
      },
      {
        name: "Follow-up session",
        category: "treatment",
        durationMinutes: 30,
        priceMinor: 4500,
        requires: ["Physiotherapist"],
      },
      {
        name: "Sports injury review",
        category: "assessment",
        durationMinutes: 45,
        priceMinor: 7500,
        requires: ["Senior"],
      },
    ],
    hours: [
      { weekdays: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "18:00" },
      { weekdays: [6], startTime: "09:00", endTime: "13:00" },
    ],
    slotMinutes: 15,
    articles: [
      {
        title: "What happens at a first appointment?",
        body:
          "Your first appointment is an assessment and runs for about 45 minutes.\n\n" +
          "We'll ask what brought you in and how long it's been going on, take a look at how you " +
          "move, and talk through what we think would help. You'll usually leave with something " +
          "to be getting on with at home.\n\n" +
          "If we think you'd be better seen by someone else, we'll say so and point you in the " +
          "right direction rather than book you in again.",
        tags: ["visiting", "first-appointment"],
      },
      {
        title: "Do I need a referral from my GP?",
        body:
          "No. You can book with us directly and most people do.\n\n" +
          "If you're claiming on private health insurance, your insurer may ask for a GP referral " +
          "before they'll cover it — that's worth checking with them before your appointment, as " +
          "it's their rule rather than ours.",
        tags: ["booking", "referrals"],
      },
      {
        title: "What should I wear or bring?",
        body:
          "Wear something you can move comfortably in. For a lower back, hip or knee problem, " +
          "shorts are ideal; for a shoulder or neck, a vest or a loose t-shirt.\n\n" +
          "Bring any scan results or letters you already have, and a list of anything you're " +
          "currently taking. If you're claiming on insurance, bring your policy and " +
          "authorisation number.",
        tags: ["visiting", "preparing"],
      },
      {
        title: "What is your cancellation policy?",
        body:
          "We ask for 24 hours' notice to change or cancel an appointment.\n\n" +
          "Inside 24 hours we charge the full fee for the appointment, because the time is very " +
          "hard to fill at short notice. If something genuinely unavoidable happens, tell us — " +
          "we'd rather hear from you than not.",
        tags: ["policy", "cancellation"],
      },
      {
        title: "Where are you and is there parking?",
        body:
          "We're on Northgate Street, a five-minute walk from the station.\n\n" +
          "There's metered parking on the street outside, free after 18:00 and on Sundays. The " +
          "entrance is level and there's a lift to the treatment rooms on the first floor.",
        tags: ["visiting", "getting-here"],
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════
  //  Real estate
  // ══════════════════════════════════════════════════════════════════
  {
    id: "property",
    slug: `${DEMO_SLUG_PREFIX}property`,
    businessName: "Marina Bay Property",
    tab: "Real estate",
    trade: "Estate agency · Dubai",
    blurb:
      "Books viewings and valuations in Asia/Dubai, prices in AED. Won't discuss what an owner would accept.",
    starters: [
      "can I see a two-bed this week?",
      "is there a charge for a viewing?",
      "would the owner take 10% under asking?",
    ],

    timezone: "Asia/Dubai",
    currency: "AED",
    locationName: "Marina Bay Office",
    descriptor:
      "An estate agency arranging property viewings, valuations and mortgage conversations by appointment. Viewings are accompanied by one of our agents, who meets you at the property.",
    toneNote:
      "Write plainly and practically, like a busy agent texting between viewings. Confirm the details back.",
    escalationTopics: [
      "what an owner would accept, or anything to do with negotiating a price or making an offer",
      "tenancy law, contracts, deposits and disputes",
      "whether a specific property will still be available at a future date",
    ],
    resources: [
      { name: "Layla Haddad", kind: "person", tags: ["Agent", "Senior"] },
      { name: "Daniel Okonkwo", kind: "person", tags: ["Agent"] },
    ],
    services: [
      {
        // No price on purpose. A viewing is free, and the article says so — which
        // is the whole point: the number the assistant will not invent is one the
        // business wrote down instead.
        name: "Property viewing",
        category: "viewing",
        durationMinutes: 45,
        priceMinor: null,
        requires: ["Agent"],
      },
      {
        name: "Valuation appointment",
        category: "valuation",
        durationMinutes: 60,
        priceMinor: null,
        requires: ["Senior"],
      },
      {
        name: "Mortgage consultation",
        category: "advice",
        durationMinutes: 30,
        priceMinor: null,
        requires: ["Agent"],
      },
    ],
    hours: [
      { weekdays: [1, 2, 3, 4, 5], startTime: "10:00", endTime: "19:00" },
      { weekdays: [6], startTime: "11:00", endTime: "16:00" },
    ],
    slotMinutes: 30,
    articles: [
      {
        title: "Is there a charge for a viewing?",
        body:
          "No. Viewings, valuations and an initial mortgage conversation are all free — you only " +
          "pay us if you go on to buy or rent through us, and we'll set out exactly what that " +
          "costs before you commit to anything.",
        tags: ["fees", "viewing"],
      },
      {
        title: "What do I need to bring to a viewing?",
        body:
          "Photo ID — Emirates ID or passport. That's it for a first viewing.\n\n" +
          "If you're likely to move quickly, it's worth having proof of funds or a mortgage " +
          "pre-approval with you, as it puts you in a stronger position if you decide you want " +
          "the property.",
        tags: ["viewing", "preparing"],
      },
      {
        title: "Can I view a property outside office hours?",
        body:
          "Sometimes, but it depends entirely on the owner or the current tenant, so we can't " +
          "promise it over a message.\n\n" +
          "Book a time that works during the day and mention that evenings suit you better — " +
          "the agent will ask on your behalf and come back to you.",
        tags: ["viewing", "booking"],
      },
      {
        title: "How does making an offer work?",
        body:
          "Offers go through the agent handling the property, never over chat.\n\n" +
          "Once you've seen somewhere and want to proceed, tell the agent at the viewing or ask " +
          "us to have them call you. They'll take you through what to offer, what the owner has " +
          "said about timing, and what happens next.",
        tags: ["buying", "offers"],
      },
      {
        title: "Do you handle rentals as well as sales?",
        body:
          "Yes, both. Rentals in Dubai are usually paid annually in a set number of cheques, and " +
          "the number of cheques is often negotiable — the agent will go through it with you.\n\n" +
          "Say which you're after when you book and we'll put you with the right person.",
        tags: ["rentals", "buying"],
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════
  //  Insurance
  // ══════════════════════════════════════════════════════════════════
  {
    id: "insurance",
    slug: `${DEMO_SLUG_PREFIX}insurance`,
    businessName: "Ashwell Insurance Advisers",
    tab: "Insurance",
    trade: "Advisory practice · Mumbai",
    blurb:
      "Books adviser appointments in Asia/Kolkata, prices in INR. Never says whether a claim will be paid.",
    starters: [
      "what does a policy review cost?",
      "book me in with someone next tuesday",
      "will my claim for water damage be covered?",
    ],

    timezone: "Asia/Kolkata",
    currency: "INR",
    locationName: "Ashwell Andheri",
    descriptor:
      "An independent insurance advisory practice. Clients book an appointment with an adviser to review cover they already hold, arrange new cover, or get help putting a claim together.",
    toneNote:
      "Write formally but warmly, in short messages. Never speculate about whether something is covered.",
    escalationTopics: [
      "whether a particular claim or incident is covered, and anything about a claim already in progress",
      "quoting a premium, or estimating what cover will cost",
      "advice on which policy someone should hold",
    ],
    resources: [
      { name: "Meera Shah", kind: "person", tags: ["Adviser", "Senior"] },
      { name: "Rahul Desai", kind: "person", tags: ["Adviser"] },
    ],
    services: [
      {
        name: "Policy review",
        category: "review",
        durationMinutes: 30,
        priceMinor: 0,
        requires: ["Adviser"],
      },
      {
        name: "New cover consultation",
        category: "advice",
        durationMinutes: 45,
        priceMinor: 150000,
        requires: ["Adviser"],
      },
      {
        name: "Claim support appointment",
        category: "claims",
        durationMinutes: 30,
        priceMinor: 0,
        requires: ["Senior"],
      },
    ],
    hours: [
      { weekdays: [1, 2, 3, 4, 5], startTime: "10:00", endTime: "18:00" },
      { weekdays: [6], startTime: "10:00", endTime: "14:00" },
    ],
    slotMinutes: 30,
    articles: [
      {
        title: "What happens in a policy review?",
        body:
          "An adviser goes through the cover you already hold — what it protects, what it " +
          "excludes, when it renews and what it costs you — and tells you plainly where they " +
          "think there's a gap or an overlap.\n\n" +
          "It takes about half an hour and there's no charge for it. You're under no obligation " +
          "to change anything afterwards.",
        tags: ["appointments", "review"],
      },
      {
        title: "What should I bring to my appointment?",
        body:
          "Your current policy documents — the schedule rather than the full booklet is fine — " +
          "and your last renewal notice.\n\n" +
          "For a claim support appointment, bring anything you already have about the incident: " +
          "photographs, receipts, an FIR copy if there is one, and any correspondence from the " +
          "insurer.",
        tags: ["appointments", "preparing"],
      },
      {
        title: "How do I start a claim?",
        body:
          "Notify your insurer directly first — most policies require it within a set number of " +
          "days, and the clock starts at the incident, not at your appointment.\n\n" +
          "Then book a claim support appointment with us. An adviser will go through the " +
          "paperwork with you and deal with the insurer on your behalf where the policy allows " +
          "it. We can't tell you what the insurer will decide.",
        tags: ["claims"],
      },
      {
        title: "Do you charge for an appointment?",
        body:
          "A policy review and a claim support appointment are free.\n\n" +
          "A new cover consultation carries a fee, which is shown when you book and is set " +
          "against the first year's premium if you go ahead through us.",
        tags: ["fees", "appointments"],
      },
      {
        title: "Are you tied to one insurer?",
        body:
          "No. We're independent and place business across a number of insurers, which is why a " +
          "review is worth having even if you're happy with what you hold.\n\n" +
          "We're paid commission by the insurer when cover is placed. An adviser will tell you " +
          "what that is on any policy they recommend, before you sign anything.",
        tags: ["about-us"],
      },
    ],
  },
];

export function findDemoPersona(id: string): DemoPersona | undefined {
  return DEMO_PERSONAS.find((p) => p.id === id);
}
