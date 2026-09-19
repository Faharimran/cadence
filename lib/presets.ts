import type { Capability, ExceptionEffect } from "@prisma/client";

/**
 * Starting points, not templates.
 *
 * A preset writes ordinary rows — exception types, tags, a tone note, a draft
 * article — and then has no further existence. Nothing in the engine, the agent
 * or the API ever reads `Tenant.vertical`, and nothing may start: the moment
 * behaviour branches on which preset was chosen, enori owns a vertical again
 * and every new industry becomes a code change.
 *
 * What they are actually for is the empty state. A business that signs up and
 * sees nine blank screens abandons the setup; one that sees its own vocabulary
 * already in place ("Chair", "Day off", "Do you take walk-ins?") finishes it.
 *
 * Every preset here is an APPOINTMENT business — something a customer occupies
 * for a duration. That is the shape enori models. A shop selling ice cream
 * over a counter is a different transaction entirely (an order, not a booking)
 * and no preset can bridge that; it needs an engine this product does not yet
 * have. Better a short honest list than one that mis-sells.
 */

export type PresetExceptionType = {
  code: string;
  label: string;
  effect: ExceptionEffect;
  priority: number;
  publicVisible?: boolean;
  publicReason?: string;
};

export type PresetService = {
  name: string;
  category: string;
  durationMinutes: number;
  /** Tags a resource must carry to perform it. */
  requires: string[];
};

export type Preset = {
  id: string;
  label: string;
  /** Shown under the label when choosing. Concrete examples beat abstractions. */
  blurb: string;
  /** Seeds Tenant.descriptor; the owner edits it afterwards. */
  descriptor: string;
  toneNote: string;
  escalationTopics: string[];
  /** Suggested vocabulary for people, rooms and equipment. */
  resourceTags: string[];
  exceptionTypes: PresetExceptionType[];
  services: PresetService[];
  /**
   * One draft article, in the shape a good one takes: titled as the customer
   * would ask it, answered in the business's own voice. Draft, so it cannot
   * reach anybody until a human has read and approved it.
   */
  starterDoc: { title: string; body: string; tags: string[] };
  capabilities: Capability[];
};

/** Every preset gets these; a business without them cannot hold a conversation. */
const BASE_CAPABILITIES: Capability[] = [
  "customers",
  "catalog",
  "availability",
  "booking_read",
  "booking_write",
  "knowledge",
];

/** "Clinic closed" is universal — a business that never shuts is not a business. */
const CLOSED: PresetExceptionType = {
  code: "closed",
  label: "Closed",
  effect: "subtract",
  priority: 100,
  publicVisible: true,
  publicReason: "We're closed that day.",
};

export const PRESETS: Preset[] = [
  {
    id: "clinic",
    label: "Clinic or medical practice",
    blurb: "Hair, skin, dental, physio, veterinary — anywhere a practitioner sees patients by appointment.",
    descriptor:
      "A clinic offering consultations and treatments by appointment. Patients are seen by a named practitioner, and some procedures need a room or theatre as well.",
    toneNote:
      "Write like a careful receptionist: warm, clear, never clinical. Do not reassure about outcomes.",
    escalationTopics: [
      "anything clinical — symptoms, suitability, risks, recovery, medication",
      "the total cost of a procedure, as opposed to a fixed consultation fee",
      "anything a patient describes as urgent or painful",
    ],
    resourceTags: ["Consultant", "Surgeon", "Nurse", "Treatment room", "Theatre"],
    exceptionTypes: [
      CLOSED,
      { code: "leave", label: "Leave", effect: "subtract", priority: 50 },
      { code: "procedure_day", label: "Procedure day", effect: "subtract", priority: 60 },
      { code: "extra_clinic", label: "Extra clinic", effect: "add", priority: 200 },
    ],
    services: [
      { name: "Consultation", category: "consult", durationMinutes: 30, requires: ["Consultant"] },
    ],
    starterDoc: {
      title: "What happens at a first consultation?",
      body:
        "Replace this with your own words — this is here to show the shape.\n\n" +
        "A good article answers one question a patient actually asks, in the voice you'd use " +
        "at the front desk. Say what happens, how long it takes, and what to bring. Leave out " +
        "anything you would want a clinician to say in person: the assistant will hand those " +
        "questions over rather than answer them.\n\n" +
        "This article is a draft, so the assistant cannot see it. Approve it when it's right.",
      tags: ["visiting"],
    },
    capabilities: [...BASE_CAPABILITIES, "promotions"],
  },
  {
    id: "barber",
    label: "Barber or hair salon",
    blurb: "Cuts, colour and styling, booked with a particular stylist or with whoever is free.",
    descriptor:
      "A barber shop taking appointments for cuts, beard work and styling. Customers often ask for a particular barber, and sometimes just want the soonest slot.",
    toneNote: "Write like a friendly shop: short, easy, first names.",
    escalationTopics: ["complaints about a previous cut", "anything about refunds"],
    resourceTags: ["Barber", "Stylist", "Chair", "Wash basin"],
    exceptionTypes: [
      CLOSED,
      { code: "day_off", label: "Day off", effect: "subtract", priority: 50 },
      { code: "training", label: "Training", effect: "subtract", priority: 55 },
      { code: "late_night", label: "Late night", effect: "add", priority: 200 },
    ],
    services: [
      { name: "Haircut", category: "cut", durationMinutes: 30, requires: ["Barber"] },
      { name: "Beard trim", category: "cut", durationMinutes: 15, requires: ["Barber"] },
    ],
    starterDoc: {
      title: "Do you take walk-ins?",
      body:
        "Replace this with your own answer — this is here to show the shape.\n\n" +
        "Say what actually happens when someone turns up without booking, and when the quiet " +
        "times are. One question, answered plainly, in the voice you'd use in the shop.\n\n" +
        "This article is a draft, so the assistant cannot see it. Approve it when it's right.",
      tags: ["visiting"],
    },
    capabilities: [...BASE_CAPABILITIES, "promotions"],
  },
  {
    id: "salon",
    label: "Beauty, nails or spa",
    blurb: "Treatments booked into a room or a station, often as a course rather than one visit.",
    descriptor:
      "A salon offering beauty and wellbeing treatments by appointment. Some treatments need a specific room; several are usually bought as a course of sessions.",
    toneNote: "Write warmly and unhurriedly, but keep messages short.",
    escalationTopics: [
      "skin reactions or anything a client describes as sore",
      "the price of a course of treatments, as opposed to a single session",
    ],
    resourceTags: ["Therapist", "Technician", "Treatment room", "Station"],
    exceptionTypes: [
      CLOSED,
      { code: "leave", label: "Leave", effect: "subtract", priority: 50 },
      { code: "room_closed", label: "Room unavailable", effect: "subtract", priority: 60 },
      { code: "late_night", label: "Late night", effect: "add", priority: 200 },
    ],
    services: [
      { name: "Facial", category: "treatment", durationMinutes: 60, requires: ["Therapist"] },
    ],
    starterDoc: {
      title: "How should I prepare for a treatment?",
      body:
        "Replace this with your own words — this is here to show the shape.\n\n" +
        "Say what a client should and shouldn't do beforehand, and how early to arrive. " +
        "Keep it to what you'd happily have repeated verbatim to someone you've never met.\n\n" +
        "This article is a draft, so the assistant cannot see it. Approve it when it's right.",
      tags: ["preparing"],
    },
    capabilities: [...BASE_CAPABILITIES, "promotions"],
  },
  {
    id: "studio",
    label: "Studio or instructor",
    blurb: "Photography, fitness, music, driving lessons — time booked with a person, a space, or both.",
    descriptor:
      "A studio taking bookings for sessions with an instructor, a space, or both together.",
    toneNote: "Write plainly and practically. Confirm the details back.",
    escalationTopics: ["cancellation charges", "anything about hiring the space for an event"],
    resourceTags: ["Instructor", "Studio", "Equipment"],
    exceptionTypes: [
      CLOSED,
      { code: "leave", label: "Leave", effect: "subtract", priority: 50 },
      { code: "maintenance", label: "Maintenance", effect: "subtract", priority: 60 },
      { code: "extra_session", label: "Extra session", effect: "add", priority: 200 },
    ],
    services: [
      { name: "Session", category: "session", durationMinutes: 60, requires: ["Instructor"] },
    ],
    starterDoc: {
      title: "What should I bring?",
      body:
        "Replace this with your own words — this is here to show the shape.\n\n" +
        "Answer the question a first-timer always asks. Say what's provided and what isn't.\n\n" +
        "This article is a draft, so the assistant cannot see it. Approve it when it's right.",
      tags: ["preparing"],
    },
    capabilities: BASE_CAPABILITIES,
  },
  {
    id: "workshop",
    label: "Garage or repair shop",
    blurb: "Vehicles and equipment booked into a bay with a technician.",
    descriptor:
      "A workshop booking vehicles in for servicing and repair. A job occupies a bay and a technician, and the real work is often only known once it has been looked at.",
    toneNote: "Write plainly and factually. Never speculate about a fault.",
    escalationTopics: [
      "what a repair will cost before anyone has looked at the vehicle",
      "how long a repair will take, beyond the booked slot",
      "whether something is safe to drive",
    ],
    resourceTags: ["Technician", "Bay", "Ramp", "Diagnostics"],
    exceptionTypes: [
      CLOSED,
      { code: "leave", label: "Leave", effect: "subtract", priority: 50 },
      { code: "bay_down", label: "Bay out of use", effect: "subtract", priority: 60 },
      { code: "saturday_opening", label: "Saturday opening", effect: "add", priority: 200 },
    ],
    services: [
      { name: "Diagnostic check", category: "inspection", durationMinutes: 60, requires: ["Technician"] },
    ],
    starterDoc: {
      title: "How long will my car be with you?",
      body:
        "Replace this with your own words — this is here to show the shape.\n\n" +
        "Say what a customer can expect on the day, and be clear about what you can't know " +
        "until you've looked. The assistant will hand over anything that needs a real answer.\n\n" +
        "This article is a draft, so the assistant cannot see it. Approve it when it's right.",
      tags: ["visiting"],
    },
    capabilities: BASE_CAPABILITIES,
  },
  {
    id: "other",
    label: "Something else",
    blurb: "Start empty. Everything a preset would have set, you can set yourself.",
    descriptor: "",
    toneNote: "",
    escalationTopics: [],
    resourceTags: [],
    exceptionTypes: [CLOSED],
    services: [],
    starterDoc: {
      title: "What should I know before my first visit?",
      body:
        "Replace this with your own words — this is here to show the shape.\n\n" +
        "Pick one question customers actually ask and answer it the way you would in person. " +
        "The assistant can only repeat what's written here; anything else it hands to a colleague.\n\n" +
        "This article is a draft, so the assistant cannot see it. Approve it when it's right.",
      tags: [],
    },
    capabilities: BASE_CAPABILITIES,
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
