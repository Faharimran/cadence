/**
 * What enori does for eight trades, in the words their owners use.
 *
 * This is the page's answer to "is it for a business like mine", and it is the
 * easiest place on the site to start lying. So two rules govern every line
 * below, and both are checkable:
 *
 *  1. **Every bullet names something this repository does.** Live availability
 *     is `lib/engine/availability.ts`. Holding before promising is `holdSlot`
 *     plus a Postgres exclusion constraint. Approved-only answers is
 *     `KnowledgeDoc.status`. Hand-over is `escalate_to_human` and
 *     `Tenant.escalationTopics`. Nothing here describes a roadmap.
 *
 *     Three things a competitor's version of this page would claim and this one
 *     does not: **reminders** (the `notifications` capability is an enum member
 *     no code reads), **CRM integrations** (`CapabilityMode.brokered` exists in
 *     the schema; not one connector is written), and any channel but WhatsApp
 *     and the web demo. When they ship, they go here. Not before.
 *
 *  2. **Every trade is an appointment business.** Something a customer occupies
 *     for a duration. Shops, restaurants and delivery are an order — stock, a
 *     basket, fulfilment — and the engine has none of that. `NOT_FOR` says so
 *     on the page rather than letting a retailer find out during onboarding.
 *
 * The `neverDoes` line on each trade is not a disclaimer. It is the product: a
 * business buying an assistant is buying what it will refuse to say, and the
 * trade that cares most is the one most likely to buy.
 */

/** Small inline glyphs, keyed rather than imported — the page ships no icon set. */
export type CardIcon =
  | "calendar"
  | "shield"
  | "chat"
  | "handover"
  | "layers"
  | "doc"
  | "clock"
  | "plug"
  | "globe"
  | "tag";

export type IndustryCard = {
  icon: CardIcon;
  label: string;
  /** One line on what it actually does. */
  note: string;
};

export type Industry = {
  id: string;
  tab: string;
  headline: string;
  lede: string;
  /** What the assistant handles. Five, because six stops being read. */
  handles: string[];
  /** What it refuses, in the shape a tenant writes it. */
  neverDoes: string;
  cards: IndustryCard[];
  /** The preset that seeds this trade's vocabulary, from lib/presets.ts. */
  presetId: string;
  /** Set where a live agent for this trade is already on the page. */
  demo?: string;
};

/** Said plainly under the tabs. See rule 2 above. */
export const NOT_FOR =
  "Not on this list: shops, restaurants, delivery. Those are orders — a basket, stock, " +
  "fulfilment — and enori doesn't model any of it. Better to say so here than three " +
  "weeks into your setup.";

export const INDUSTRIES: Industry[] = [
  // ══════════════════════════════════════════════════════════════════
  {
    id: "healthcare",
    tab: "Healthcare",
    headline: "Fill the diary without putting a patient on hold",
    lede:
      "Patients ask the same twelve questions and want a time. The assistant answers from what your practice approved, offers a slot it is already holding, and stops the moment a question turns clinical.",
    handles: [
      "Booking, rescheduling and cancelling against the live diary",
      "“What happens at a first appointment?” — in your words, never the model's",
      "Practitioner leave, without closing the rest of the clinic",
      "Appointments that need a room or a machine as well as a person",
      "Referral and insurance questions you have already written down",
    ],
    neverDoes:
      "Symptoms, suitability, recovery times and anything a patient calls urgent go to a clinician. You write that list in your own words.",
    cards: [
      { icon: "shield", label: "Approved answers only", note: "A draft cannot reach a patient. Editing live text takes it offline." },
      { icon: "calendar", label: "Live diary", note: "Computed per question from hours, leave and bookings. Never cached." },
      { icon: "layers", label: "Clinician and room together", note: "Both held for one appointment, or neither is." },
      { icon: "clock", label: "Held before promised", note: "The slot is reserved before anyone is told it is theirs." },
      { icon: "handover", label: "Clinical questions handed over", note: "The thread pauses and waits for a person." },
    ],
    presetId: "clinic",
    demo: "clinic",
  },

  // ══════════════════════════════════════════════════════════════════
  {
    id: "dental",
    tab: "Dental",
    headline: "Three surgeries, two hygienists, one diary that is never wrong",
    lede:
      "A practice this shape is a scheduling problem the phone cannot solve. enori works the answer out per question, holds the chair and the dentist together, and refuses to quote a price you have not published.",
    handles: [
      "Check-ups and hygiene visits, with a named dentist or whoever is free",
      "A chair, a surgery and a clinician held as one appointment",
      "Prices only where you publish one — everything else goes to the desk",
      "Pain and emergency messages routed to a person immediately",
      "Your cancellation policy, quoted exactly as you wrote it",
    ],
    neverDoes:
      "Diagnosis, whether a treatment is suitable, and what a plan will come to in total. A fixed consultation fee is a number; a treatment plan is a conversation.",
    cards: [
      { icon: "tag", label: "Price on request", note: "A service marked non-quotable carries no number into the prompt at all." },
      { icon: "layers", label: "Chair, surgery, clinician", note: "Multi-resource bookings, held atomically." },
      { icon: "calendar", label: "Live availability", note: "Three layers: schedule − exceptions + extra sessions − bookings." },
      { icon: "doc", label: "Your policy, verbatim", note: "Upload the practice PDF; it comes back as drafts to approve." },
      { icon: "handover", label: "Anything clinical", note: "Handed over without exception, on your list." },
    ],
    presetId: "clinic",
  },

  // ══════════════════════════════════════════════════════════════════
  {
    id: "beauty",
    tab: "Beauty & grooming",
    headline: "Saturday fills itself, long after you have locked up",
    lede:
      "Most booking messages arrive after closing. The assistant answers them on WhatsApp, offers a stylist and a time it has already held, and cannot promise the same slot twice.",
    handles: [
      "Booking with a named stylist, or whoever is free soonest",
      "Cuts, colour and treatments with real durations and turnaround time",
      "Walk-in and opening-hours questions, from your own answer",
      "A chair, a basin or a room booked alongside the person",
      "Offers repeated in the wording you approved, never recalculated",
    ],
    neverDoes:
      "Complaints about a previous visit and anything about a refund come to you. So does negotiating on price.",
    cards: [
      { icon: "chat", label: "Answers on WhatsApp", note: "The channel your customers already message you on." },
      { icon: "clock", label: "Hold, then promise", note: "Two people asking in the same second cannot both get 10:30." },
      { icon: "calendar", label: "Turnaround built in", note: "Buffers block the chair as well as the appointment." },
      { icon: "tag", label: "Offers as written", note: "It never describes a discount in its own words or does the sums." },
      { icon: "handover", label: "Refunds and complaints", note: "Straight to you, thread paused." },
    ],
    presetId: "barber",
  },

  // ══════════════════════════════════════════════════════════════════
  {
    id: "realestate",
    tab: "Real estate",
    headline: "Every enquiry answered while the agent is at a viewing",
    lede:
      "A portal lead goes cold in an hour. The assistant replies immediately, books the viewing into that agent's live calendar, and will not say a word about what an owner would accept.",
    handles: [
      "Viewings and valuations booked against each agent's real availability",
      "Fees, ID and what to bring — from what the agency wrote down",
      "Sales and lettings enquiries routed to the right person",
      "Branches in different cities, each on its own clock and currency",
      "Messages at midnight, answered at midnight",
    ],
    neverDoes:
      "Offers, negotiation, what the owner would take, and anything touching tenancy law. All of it goes to an agent.",
    cards: [
      { icon: "globe", label: "A zone per branch", note: "Hours are local wall-clock, resolved at query time. No default zone exists." },
      { icon: "calendar", label: "Per-agent availability", note: "One agent's leave never closes the office." },
      { icon: "shield", label: "Only what you approved", note: "Ask it something undocumented and it says it will check." },
      { icon: "chat", label: "Replies in seconds", note: "Day, night, and while everyone is out on viewings." },
      { icon: "handover", label: "Price talk", note: "Recognised and handed over, every time." },
    ],
    presetId: "other",
    demo: "property",
  },

  // ══════════════════════════════════════════════════════════════════
  {
    id: "insurance",
    tab: "Insurance",
    headline: "Advisers advising, not arranging appointments",
    lede:
      "An adviser's hour is the product. enori takes review and claim appointments off their desk, and says nothing whatsoever about cover, premiums, or whether a claim will pay.",
    handles: [
      "Policy reviews, new cover and claim appointments, booked live",
      "What to bring, how long it takes, and what it costs — as written",
      "Free and chargeable appointments distinguished correctly",
      "Anything about a claim in progress handed straight to an adviser",
      "Fees in your currency, times in your zone, with no default anywhere",
    ],
    neverDoes:
      "Whether a claim is covered, what a premium will cost, and which policy someone should hold. Three questions that must never be answered by a model.",
    cards: [
      { icon: "shield", label: "Approved text only", note: "The corpus is the only source. Anything else is escalated." },
      { icon: "doc", label: "Traceable replies", note: "Every message records which article it read, at which version." },
      { icon: "handover", label: "Your hand-over list", note: "Written in your words, applied without exception." },
      { icon: "globe", label: "Your currency", note: "Money is integer minor units. No float ever touches a price." },
      { icon: "calendar", label: "Live adviser diary", note: "Availability is computed, never stored." },
    ],
    presetId: "other",
    demo: "insurance",
  },

  // ══════════════════════════════════════════════════════════════════
  {
    id: "automotive",
    tab: "Automotive",
    headline: "The bay booked, the quote left to you",
    lede:
      "A garage that quotes a repair over chat has committed to it. enori books the vehicle into a bay with a technician, and refuses to guess at anything nobody has looked at yet.",
    handles: [
      "Servicing, inspections and diagnostics booked into a bay with a technician",
      "A bay out of use removed from availability without closing the shop",
      "Long jobs occupying the ramp for as long as they really take",
      "Opening hours, courtesy cars and what to bring, from your own answers",
      "A one-off Saturday opening added without changing the weekly pattern",
    ],
    neverDoes:
      "What a repair will cost before it has been seen, how long it will really take, and whether something is safe to drive.",
    cards: [
      { icon: "layers", label: "Bay and technician", note: "Held together as one job, or not at all." },
      { icon: "calendar", label: "Add and subtract", note: "Exceptions both ways: a bay down, an extra Saturday." },
      { icon: "clock", label: "Real durations", note: "A four-hour job blocks four hours, plus turnaround." },
      { icon: "shield", label: "No invented quotes", note: "It states no price a tool did not hand it." },
      { icon: "handover", label: "Anything unseen", note: "Diagnosis over chat is exactly what it refuses." },
    ],
    presetId: "workshop",
  },

  // ══════════════════════════════════════════════════════════════════
  {
    id: "studios",
    tab: "Fitness & studios",
    headline: "A timetable that changes weekly, answered correctly every time",
    lede:
      "One instructor, several spaces, and a schedule that never looks the same twice. Availability is worked out per question from your hours, your time off and your bookings — never from a copy that went stale on Tuesday.",
    handles: [
      "Sessions booked with an instructor, a space, or both together",
      "An extra class added for one week without touching the recurring pattern",
      "Instructor leave that does not close the studio",
      "What to bring and what is provided, from your own words",
      "Cancellation terms quoted exactly as you wrote them",
    ],
    neverDoes:
      "Cancellation charges and hiring the space for an event. Both are negotiations, and both come to you.",
    cards: [
      { icon: "calendar", label: "Pattern plus exceptions", note: "A recurring rota, with one-offs layered over it." },
      { icon: "layers", label: "Person and space", note: "A studio session can need both. It books both." },
      { icon: "clock", label: "Never a stale answer", note: "There is no isAvailable column, and there never will be." },
      { icon: "shield", label: "Your terms, verbatim", note: "Approved once, quoted the same way every time." },
      { icon: "handover", label: "Money conversations", note: "Charges and hire go to a person." },
    ],
    presetId: "studio",
  },

  // ══════════════════════════════════════════════════════════════════
  {
    id: "veterinary",
    tab: "Veterinary",
    headline: "Consults booked. Clinical questions never answered.",
    lede:
      "Owners message about an animal at ten at night, and the single worst thing an assistant can do is reassure them. enori books the consult and hands everything else to a vet.",
    handles: [
      "Consults and follow-ups booked with a named vet",
      "A consult room held alongside the vet",
      "Out-of-hours arrangements, repeated exactly as the practice wrote them",
      "How to prepare a nervous animal, and what to bring",
      "Vet leave applied per person, not across the whole practice",
    ],
    neverDoes:
      "Symptoms, medication, and whether to come in tonight. Every one of them goes to a vet, however the question is phrased.",
    cards: [
      { icon: "handover", label: "Clinical, always", note: "The escalation list is the first thing this trade should write." },
      { icon: "shield", label: "No general knowledge", note: "A model knows plenty about animals. None of it may be spoken as you." },
      { icon: "layers", label: "Vet and room", note: "Both, atomically." },
      { icon: "calendar", label: "Per-vet leave", note: "One vet away; the practice stays open." },
      { icon: "doc", label: "Your written answers", note: "Upload the practice handbook and approve what comes back." },
    ],
    presetId: "clinic",
  },
];

export function findIndustry(id: string): Industry | undefined {
  return INDUSTRIES.find((i) => i.id === id);
}
