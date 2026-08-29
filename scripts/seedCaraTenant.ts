/**
 * A tenant modelled on Cara — a real hair-transplant and aesthetics clinic in
 * Mumbai — using their actual treatments, prices and constraints.
 *
 * The point is not a second demo. It is to check the engine against a business
 * whose rules were written by someone else, and which differ from the studio
 * fixture in ways that matter:
 *
 *   · Asia/Kolkata — no DST at all, unlike Europe/London
 *   · a six-day week; Saturday is a working day
 *   · consultations are quotable at a fixed fee, but a TRANSPLANT TOTAL IS NOT.
 *     Their call rulebook forbids quoting a final surgical cost, so the price is
 *     withheld from the assistant entirely rather than it being told not to say
 *     it. That constraint is the whole reason `priceQuotable` exists.
 *   · a transplant occupies a surgeon AND a theatre for a full day — the
 *     compound-resource case a single-resource model cannot express
 *
 * Run: npm run seed:cara
 */
import { adminDb } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";

const SLUG = "cara-clinic";

async function main() {
  await adminDb.tenant.deleteMany({ where: { slug: SLUG } });

  const tenant = await adminDb.tenant.create({
    data: {
      slug: SLUG,
      name: "Cara Clinic",
      timezone: "Asia/Kolkata",
      currency: "INR",
      taxLabel: "GST",
      taxRate: 5,
      taxInclusive: false,
      vertical: "clinic",
      // These three used to be sentences hardcoded in agent.ts, which meant a
      // barber inherited a hair clinic's caution about anything "clinical".
      // They are tenant data now, and this is what a clinic fills them with.
      descriptor:
        "A hair and skin clinic in Mumbai. Patients come first for a consultation, and treatments " +
        "range from a single PRP session to a full-day transplant that occupies both a surgeon and " +
        "the theatre.",
      toneNote:
        "Write like a careful receptionist: warm, clear, never clinical. Do not reassure about results.",
      escalationTopics: [
        "anything clinical — suitability, graft counts, risks, medication, recovery",
        "the total cost of a transplant, as opposed to the fixed consultation fee",
        "anything a patient describes as urgent, painful or going wrong",
      ],
    },
  });

  await adminDb.tenantCapability.createMany({
    data: (
      [
        ["customers", 300],
        ["catalog", 21_600],
        ["availability", 60],
        ["booking_read", 60],
        ["booking_write", 60],
        ["promotions", 900],
        ["knowledge", 21_600],
      ] as const
    ).map(([capability, ttl]) => ({
      tenantId: tenant.id,
      capability,
      mode: "hosted" as const,
      snapshotTtlSeconds: ttl,
    })),
  });

  const santacruz = await adminDb.location.create({
    data: { tenantId: tenant.id, name: "Santacruz", code: "SCZ", timezone: "Asia/Kolkata" },
  });
  const juhu = await adminDb.location.create({
    data: { tenantId: tenant.id, name: "Juhu", code: "JUH", timezone: "Asia/Kolkata" },
  });

  // Cara's own speciality vocabulary: Hair, Skin, Face.
  const drMehta = await adminDb.resource.create({
    data: {
      tenantId: tenant.id,
      name: "Dr Mehta",
      kind: "person",
      tags: ["Hair", "Surgeon", "Consultant"],
    },
  });
  const drIyer = await adminDb.resource.create({
    data: { tenantId: tenant.id, name: "Dr Iyer", kind: "person", tags: ["Hair", "Consultant"] },
  });
  const drShah = await adminDb.resource.create({
    data: { tenantId: tenant.id, name: "Dr Shah", kind: "person", tags: ["Skin", "Consultant"] },
  });
  const theatre = await adminDb.resource.create({
    data: { tenantId: tenant.id, name: "Theatre 1", kind: "room", tags: ["OT"] },
  });

  await adminDb.resourceLocation.createMany({
    data: [
      { tenantId: tenant.id, resourceId: drMehta.id, locationId: santacruz.id },
      { tenantId: tenant.id, resourceId: drIyer.id, locationId: santacruz.id },
      { tenantId: tenant.id, resourceId: drShah.id, locationId: santacruz.id },
      { tenantId: tenant.id, resourceId: theatre.id, locationId: santacruz.id },
      { tenantId: tenant.id, resourceId: drIyer.id, locationId: juhu.id },
      { tenantId: tenant.id, resourceId: drShah.id, locationId: juhu.id },
    ],
  });

  // Prices are the real ones from data/catalog.csv, in paise.
  const services = [
    {
      name: "Hair Consultation",
      category: "consult",
      durationMinutes: 30,
      priceMinor: 200_000, // ₹2,000
      priceQuotable: true, // a fixed consult fee is safe to state
      requirement: { tags: ["Hair", "Consultant"], kind: "person" as const, quantity: 1 },
    },
    {
      name: "Skin Consultation",
      category: "consult",
      durationMinutes: 30,
      priceMinor: 200_000,
      priceQuotable: true,
      requirement: { tags: ["Skin", "Consultant"], kind: "person" as const, quantity: 1 },
    },
    {
      name: "Hair PRP",
      category: "regenerative",
      durationMinutes: 45,
      bufferAfterMinutes: 15,
      priceMinor: 1_200_000, // ₹12,000 per session
      priceQuotable: true, // per-session pricing is quotable; a course is not
      requirement: { tags: ["Hair"], kind: "person" as const, quantity: 1 },
    },
    {
      name: "GFC Therapy",
      category: "regenerative",
      durationMinutes: 45,
      bufferAfterMinutes: 15,
      priceMinor: 1_200_000,
      priceQuotable: true,
      requirement: { tags: ["Hair"], kind: "person" as const, quantity: 1 },
    },
    {
      name: "Sapphire FUE Hair Transplant",
      category: "surgery",
      durationMinutes: 480, // a full day
      bufferAfterMinutes: 60, // theatre turnover
      priceMinor: 25_000_000, // ₹2,50,000 — recorded, never spoken
      priceQuotable: false,
      requirement: { tags: ["Surgeon"], kind: "person" as const, quantity: 1 },
      alsoNeeds: { tags: ["OT"], kind: "room" as const, quantity: 1 },
    },
  ];

  const created: Record<string, string> = {};
  for (const s of services) {
    const service = await adminDb.service.create({
      data: {
        tenantId: tenant.id,
        name: s.name,
        category: s.category,
        durationMinutes: s.durationMinutes,
        bufferAfterMinutes: s.bufferAfterMinutes ?? 0,
        priceMinor: s.priceMinor,
        priceQuotable: s.priceQuotable,
        requirements: {
          create: [
            { tenantId: tenant.id, ...s.requirement },
            ...(s.alsoNeeds ? [{ tenantId: tenant.id, ...s.alsoNeeds }] : []),
          ],
        },
      },
    });
    created[s.name] = service.id;
  }

  // Monday–Saturday, 10:00–19:00 — Indian clinic hours, six-day week.
  const rules = [];
  for (const weekday of [1, 2, 3, 4, 5, 6]) {
    for (const [resource, location] of [
      [drMehta, santacruz],
      [drIyer, santacruz],
      [drShah, santacruz],
      [theatre, santacruz],
      [drIyer, juhu],
      [drShah, juhu],
    ] as const) {
      rules.push({
        tenantId: tenant.id,
        resourceId: resource.id,
        locationId: location.id,
        weekday,
        startTime: "10:00",
        endTime: "19:00",
        slotMinutes: 30,
      });
    }
  }
  await adminDb.scheduleRule.createMany({ data: rules });

  // The clinic's own words for time off.
  await Promise.all(
    (
      [
        { code: "closed", label: "Clinic closed", effect: "subtract", priority: 100, publicVisible: true, reason: "The clinic is closed that day." },
        { code: "ot_day", label: "OT day", effect: "subtract", priority: 60 },
        { code: "leave", label: "Leave", effect: "subtract", priority: 50 },
        { code: "camp", label: "Weekend camp", effect: "add", priority: 200 },
      ] as const
    ).map((t) =>
      adminDb.exceptionType.create({
        data: {
          tenantId: tenant.id,
          code: t.code,
          label: t.label,
          effect: t.effect,
          defaultPriority: t.priority,
          publicVisible: "publicVisible" in t ? t.publicVisible : false,
          defaultPublicReason: "reason" in t ? t.reason : null,
          systemLocked: t.code === "closed",
        },
      }),
    ),
  );

  await adminDb.promotion.create({
    data: {
      tenantId: tenant.id,
      name: "Monsoon PRP offer",
      publicDescription: "There's an offer running on PRP packages this month.",
      discountType: "percent",
      discountValue: 15,
      categories: ["regenerative"],
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 30 * 86_400_000),
    },
  });

  await adminDb.customer.create({
    data: {
      tenantId: tenant.id,
      name: "Rohit Sharma",
      phone: "+919820011223",
      locale: "en-IN",
    },
  });

  // ── What the clinic will let the assistant say ──────────────────────
  //
  // Written the way a clinic actually would: answering the question a patient
  // asks, and stopping short of anything a clinician should say in person. The
  // last one is the interesting case — it is an article whose entire job is to
  // decline, so that "how many grafts do I need" produces a good hand-over
  // rather than an improvised number.
  const articles: { title: string; body: string; tags: string[] }[] = [
    {
      title: "What happens at a first consultation?",
      body:
        "Your first visit takes about thirty minutes. One of our doctors looks at your scalp, " +
        "asks about your family history and any medication you're on, and talks through what " +
        "would suit you.\n\n" +
        "You don't need to prepare anything. Come with your hair as it normally is — not freshly " +
        "oiled — and bring a list of any medicines you take.\n\n" +
        "The consultation fee is ₹2,000. If you go ahead with a treatment afterwards, that's " +
        "discussed separately at the clinic.",
      tags: ["visiting", "consultation"],
    },
    {
      title: "How long does a hair transplant take on the day?",
      body:
        "A Sapphire FUE transplant is a full day at the clinic — you'll be with us from the " +
        "morning until late afternoon. You're awake throughout, under local anaesthetic, and " +
        "there are breaks for food.\n\n" +
        "Bring a button-up shirt rather than something you pull over your head, and arrange for " +
        "someone to take you home. You won't be able to drive yourself.",
      tags: ["preparing", "transplant"],
    },
    {
      title: "What is PRP and how many sessions will I need?",
      body:
        "PRP uses a small sample of your own blood, spun to concentrate the platelets, which is " +
        "then injected into the scalp. A session takes about forty-five minutes.\n\n" +
        "Most people have it as a course rather than a one-off, but how many sessions suits you " +
        "is something the doctor decides after seeing your scalp — it isn't the same for " +
        "everyone. Ask at your consultation.",
      tags: ["treatment", "prp"],
    },
    {
      title: "Where are the clinics and how do I get there?",
      body:
        "We have two branches. Santacruz is the main one and has the theatre, so all surgery " +
        "happens there. Juhu handles consultations and skin treatments.\n\n" +
        "Both are a short auto ride from the station. Tell us which is easier for you and we'll " +
        "book you in there.",
      tags: ["visiting", "locations"],
    },
    {
      title: "Can you tell me if I'm suitable for a transplant?",
      body:
        "Not over a message, no — and we'd rather say that plainly than guess.\n\n" +
        "Whether a transplant will work well for you depends on the pattern of loss, how stable " +
        "it is, and what your donor area looks like. That needs a doctor to see it. Book a " +
        "consultation and you'll get a real answer in thirty minutes.",
      tags: ["consultation", "suitability"],
    },
  ];

  const owner = await adminDb.user.upsert({
    where: { email: "owner@cara.clinic" },
    create: {
      tenantId: tenant.id,
      email: "owner@cara.clinic",
      name: "Cara Owner",
      passwordHash: await hashPassword("correct-horse-battery"),
      role: "owner",
    },
    update: { tenantId: tenant.id, passwordHash: await hashPassword("correct-horse-battery") },
  });

  for (const article of articles) {
    const doc = await adminDb.knowledgeDoc.create({
      data: {
        tenantId: tenant.id,
        title: article.title,
        body: article.body,
        tags: article.tags,
        // Approved, because this fixture stands in for a clinic that has already
        // reviewed its own content. A brand-new tenant gets drafts instead, and
        // that difference is the point of the approval step.
        status: "approved",
        approvedById: owner.id,
        approvedAt: new Date(),
      },
    });
    await adminDb.knowledgeRevision.create({
      data: {
        tenantId: tenant.id,
        docId: doc.id,
        version: 1,
        title: article.title,
        body: article.body,
        approvedById: owner.id,
      },
    });
  }

  console.log(`Seeded ${tenant.name} (${tenant.slug})`);
  console.log(`  locations : Santacruz, Juhu — Asia/Kolkata`);
  console.log(`  people    : Dr Mehta (surgeon), Dr Iyer, Dr Shah, Theatre 1`);
  console.log(`  services  : ${Object.keys(created).join(", ")}`);
  console.log(`  hours     : Mon–Sat 10:00–19:00`);
  console.log(`  sign in   : owner@cara.clinic / correct-horse-battery`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => adminDb.$disconnect());
