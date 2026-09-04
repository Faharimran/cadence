/**
 * Executable proof of the import pipeline.
 *
 * Imports are the one feature here that writes to a business's real catalogue
 * without anyone approving it first, so the interesting assertions are not "does
 * it import" — they are the ones about restraint: a bad cell costing one row and
 * not three hundred, an absent row not being treated as a deletion, a second
 * sync of an unchanged sheet doing nothing at all, and an undo that actually
 * puts everything back.
 *
 * Runs against a throwaway tenant of its own, created and dropped here, so it
 * cannot disturb the fixtures the other harnesses assert on.
 *
 * Run: npm run prove:import
 */
import { adminDb, withTenant } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { parseCsv, toRecords, resolveSheetUrl, SheetError } from "@/lib/imports/sheet";
import { parseMoney, parseDuration, parseBoolean, parseShifts, minorUnitFactor } from "@/lib/imports/fields";
import { applySheet, revertRun } from "@/lib/imports/apply";

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

const SLUG = "__import_probe";

async function main() {
  // ── 1. CSV, parsed rather than split ────────────────────────────────
  console.log("\n1. CSV that a spreadsheet actually produces");

  const grid = parseCsv(
    '﻿Name,Price,Notes\r\n' +
      '"Cut & Finish, long hair",1500,"He said ""no fringe"""\r\n' +
      '"Colour\nfull head",4000,\r\n' +
      "Blow dry,800,quick\r\n",
  );
  check("a comma inside quotes stays in its field", grid[1][0] === "Cut & Finish, long hair", grid[1][0]);
  check('an escaped "" becomes one quote', grid[1][2] === 'He said "no fringe"', grid[1][2]);
  check("a newline inside quotes does not start a row", grid[2][0] === "Colour\nfull head", JSON.stringify(grid[2][0]));
  check("the byte-order mark is not part of the first header", grid[0][0] === "Name", JSON.stringify(grid[0][0]));
  check("a trailing newline does not add an empty row", grid.length === 4, `${grid.length} rows`);

  // ── 2. Finding the table in a sheet a human keeps ───────────────────
  console.log("\n2. Finding the table in a sheet a person maintains");

  const messy = toRecords(
    parseCsv(
      "Price list 2026\n" + // a title row
        "\n" + // a spacer
        "Name,Duration,Price,Price\n" +
        "Trim,30,500,600\n",
    ),
  );
  check("a title row above the table is skipped", messy.headers[0] === "Name", messy.headers.join(","));
  check("a duplicate heading is kept and disambiguated", messy.headers.includes("Price (2)"), messy.headers.join(","));
  check("both duplicate columns stay reachable", messy.rows[0]["Price"] === "500" && messy.rows[0]["Price (2)"] === "600");

  let noTable = false;
  try {
    toRecords(parseCsv("just one column\nvalue\n"));
  } catch (e) {
    noTable = e instanceof SheetError;
  }
  check("a sheet with no table says so rather than importing nothing quietly", noTable);

  // ── 3. Money, as typed by a person ──────────────────────────────────
  console.log("\n3. Prices, as people write them");

  const money = (s: string, c = "INR") => parseMoney(s, c);
  check("plain number", money("1500").ok && (money("1500") as { value: number }).value === 150000);
  check("currency symbol and thousands separator", (money("₹1,500") as { value: number }).value === 150000);
  check("decimals", (money("45.50") as { value: number }).value === 4550);
  check("European decimal comma", (money("45,50") as { value: number }).value === 4550);
  check("thousands dot with decimal comma", (money("1.500,50") as { value: number }).value === 150050);
  check("a currency code is ignored", (money("USD 45") as { value: number }).value === 4500);
  check('"on request" is a price of none, not an error', money("on request").ok && (money("on request") as { value: null }).value === null);
  check("blank is a price of none", (money("") as { value: null }).value === null);
  check("a negative price is refused", !money("-45").ok);
  // "ask Priya" is not nonsense — in a real price list it means exactly what
  // price-on-request means, and reading it as one is the right answer.
  check('"ask Priya" is price-on-request, not an error', (money("ask Priya") as { value: null }).value === null);
  check("nonsense is refused rather than guessed", !money("see photo").ok);
  check("a price with letters glued to it is refused", !money("£12abc").ok);

  // The one that silently multiplies a Tokyo price by a hundred.
  check("yen has no minor unit", minorUnitFactor("JPY") === 1);
  check("¥500 is 500, not 50,000", (money("¥500", "JPY") as { value: number }).value === 500);

  // ── 4. Durations ────────────────────────────────────────────────────
  console.log("\n4. Durations, as people write them");

  const dur = (s: string) => parseDuration(s);
  check("bare minutes", (dur("45") as { value: number }).value === 45);
  check('"45 min"', (dur("45 min") as { value: number }).value === 45);
  check('"1h 30"', (dur("1h 30") as { value: number }).value === 90);
  check('"1:30"', (dur("1:30") as { value: number }).value === 90);
  check('"2 hours"', (dur("2 hours") as { value: number }).value === 120);
  check("a bare decimal is refused as ambiguous, not guessed", !dur("1.5").ok, "1.5 could be 90 minutes or 1.5");
  check("longer than a day is refused", !dur("2000").ok);
  check("empty is refused", !dur("").ok);

  check("yes/no reading", (parseBoolean("Yes", false) as { value: boolean }).value === true);
  check("blank takes the stated default", (parseBoolean("", true) as { value: boolean }).value === true);
  check("a word that is neither is refused", !parseBoolean("maybe", true).ok);

  // ── 5. Google Sheets URLs ───────────────────────────────────────────
  console.log("\n5. Resolving what someone pasted");

  const fromBar = resolveSheetUrl(
    "https://docs.google.com/spreadsheets/d/1AbC-dEf_123/edit#gid=847362819",
  );
  check("a browser-bar URL becomes a CSV export", fromBar.fetchUrl.includes("/export?format=csv"));
  check(
    "and keeps the tab id, so it reads the tab they were looking at",
    fromBar.fetchUrl.includes("gid=847362819"),
    fromBar.fetchUrl,
  );

  const plain = resolveSheetUrl("https://example.com/export/services.csv");
  check("any other https link is taken at its word", plain.fetchUrl === "https://example.com/export/services.csv");

  let badUrl = false;
  try {
    resolveSheetUrl("my spreadsheet");
  } catch (e) {
    badUrl = e instanceof SheetError;
  }
  check("something that is not a link is refused with an explanation", badUrl);

  // ── 6. Applying to a real tenant ────────────────────────────────────
  console.log("\n6. Writing a sheet into a catalogue");

  await adminDb.tenant.deleteMany({ where: { slug: SLUG } });
  const tenant = await adminDb.tenant.create({
    data: { slug: SLUG, name: "Import Probe", timezone: "Europe/London", currency: "GBP" },
  });
  const t = tenant.id;

  const sheet = toRecords(
    parseCsv(
      "Service,Duration,Price,Category\n" +
        "Dry cut,30,£25,Hair\n" +
        "Full colour,120,£85,Colour\n" +
        "Consultation,15,,Hair\n" + // deliberately no price
        "Broken row,not a time,£10,Hair\n", // deliberately unreadable
    ),
  );
  const mapping = {
    Service: "name",
    Duration: "durationMinutes",
    Price: "priceMinor",
    Category: "category",
  };

  const first = await withTenant(t, (db) =>
    applySheet(db, {
      tenantId: t,
      kind: "services",
      currency: "GBP",
      sheet,
      mapping,
      removeMissing: false,
    }),
  );

  check("the good rows were created", first.created === 3, `created ${first.created}`);
  check("the unreadable row was skipped, not fatal", first.skipped === 1, `skipped ${first.skipped}`);
  check(
    "and it says which row and column to look at",
    first.issues.some((i) => i.row === 5 && i.column === "Duration"),
    JSON.stringify(first.issues),
  );

  const dryCut = await adminDb.service.findFirstOrThrow({ where: { tenantId: t, name: "Dry cut" } });
  check("the price landed in minor units", dryCut.priceMinor === 2500, String(dryCut.priceMinor));
  check("the duration landed", dryCut.durationMinutes === 30);
  check("a blank price becomes price-on-request, not zero",
    (await adminDb.service.findFirstOrThrow({ where: { tenantId: t, name: "Consultation" } })).priceMinor === null);

  // ── 7. Syncing again ────────────────────────────────────────────────
  console.log("\n7. Running the same sheet again");

  const second = await withTenant(t, (db) =>
    applySheet(db, { tenantId: t, kind: "services", currency: "GBP", sheet, mapping, removeMissing: false }),
  );
  check("nothing is created twice", second.created === 0, `created ${second.created}`);
  check("and nothing is updated when nothing changed", second.updated === 0, `updated ${second.updated}`);

  const total = await adminDb.service.count({ where: { tenantId: t } });
  check("the catalogue did not grow", total === 3, `${total} services`);

  // A price change in the sheet reaches the catalogue.
  const changed = toRecords(
    parseCsv("Service,Duration,Price,Category\nDry cut,30,£30,Hair\n"),
  );
  const third = await withTenant(t, (db) =>
    applySheet(db, { tenantId: t, kind: "services", currency: "GBP", sheet: changed, mapping, removeMissing: false }),
  );
  check("a changed price is picked up", third.updated === 1, `updated ${third.updated}`);
  check(
    "and only that row's price moved",
    (await adminDb.service.findFirstOrThrow({ where: { tenantId: t, name: "Dry cut" } })).priceMinor === 3000,
  );

  // ── 8. Absence is not deletion ──────────────────────────────────────
  console.log("\n8. A row missing from the sheet");

  // The previous sync had only Dry cut in it. The other two were absent.
  const stillActive = await adminDb.service.count({ where: { tenantId: t, active: true } });
  check(
    "rows absent from the sheet are left alone by default",
    stillActive === 3,
    `${stillActive} still active`,
  );

  const withRemoval = await withTenant(t, (db) =>
    applySheet(db, { tenantId: t, kind: "services", currency: "GBP", sheet: changed, mapping, removeMissing: true }),
  );
  check("turning removal on retires them", withRemoval.updated === 2, `updated ${withRemoval.updated}`);
  check(
    "retired, not deleted — a booking's history must still say what it was for",
    (await adminDb.service.count({ where: { tenantId: t } })) === 3,
  );

  // ── 9. Undo ─────────────────────────────────────────────────────────
  console.log("\n9. Taking it back");

  const reverted = await withTenant(t, (db) => revertRun(db, { tenantId: t, undo: withRemoval.undo }));
  check("the retirement was undone", reverted.restored === 2, JSON.stringify(reverted));
  check(
    "and they are offered again",
    (await adminDb.service.count({ where: { tenantId: t, active: true } })) === 3,
  );

  // Undoing the original creation removes what it created.
  const undoFirst = await withTenant(t, (db) => revertRun(db, { tenantId: t, undo: first.undo }));
  check("undoing the first import deleted the rows it created", undoFirst.deleted === 3, JSON.stringify(undoFirst));
  check("leaving an empty catalogue", (await adminDb.service.count({ where: { tenantId: t } })) === 0);

  // ── 10. Undo must not take a real booking with it ───────────────────
  console.log("\n10. Undo when a booking has since been made");

  const reimport = await withTenant(t, (db) =>
    applySheet(db, { tenantId: t, kind: "services", currency: "GBP", sheet, mapping, removeMissing: false }),
  );
  const svc = await adminDb.service.findFirstOrThrow({ where: { tenantId: t, name: "Dry cut" } });
  const loc = await adminDb.location.create({
    data: { tenantId: t, name: "Probe", timezone: "Europe/London" },
  });
  const cust = await adminDb.customer.create({ data: { tenantId: t, name: "Someone" } });
  await adminDb.booking.create({
    data: {
      tenantId: t,
      customerId: cust.id,
      serviceId: svc.id,
      locationId: loc.id,
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000 + 1_800_000),
      status: "scheduled",
    },
  });

  const guarded = await withTenant(t, (db) => revertRun(db, { tenantId: t, undo: reimport.undo }));
  check("a service with a booking is kept, not deleted", guarded.kept === 1, JSON.stringify(guarded));
  check(
    "the booking survived the undo",
    (await adminDb.booking.count({ where: { tenantId: t } })) === 1,
  );
  check(
    "but the service was retired so it stops being offered",
    (await adminDb.service.findFirstOrThrow({ where: { id: svc.id } })).active === false,
  );

  // ── 11. Customers ───────────────────────────────────────────────────
  console.log("\n11. Customers, matched on how you reach them");

  const people = toRecords(
    parseCsv(
      "Full name,Mobile,Email\n" +
        "Asha Rao,+44 7700 900111,asha@example.com\n" +
        "No Contact,,\n" +
        "Bad Email,+44 7700 900222,not-an-email\n",
    ),
  );
  const pmap = { "Full name": "name", Mobile: "phone", Email: "email" };

  const cust1 = await withTenant(t, (db) =>
    applySheet(db, { tenantId: t, kind: "customers", currency: "GBP", sheet: people, mapping: pmap, removeMissing: false }),
  );
  check("a customer with contact details is created", cust1.created === 1, `created ${cust1.created}`);
  check("one with neither phone nor email is skipped",
    cust1.issues.some((i) => i.problem.includes("No phone number and no email")), JSON.stringify(cust1.issues));
  check("a malformed email is reported against its own row",
    cust1.issues.some((i) => i.column === "Email"), JSON.stringify(cust1.issues));

  const again = await withTenant(t, (db) =>
    applySheet(db, { tenantId: t, kind: "customers", currency: "GBP", sheet: people, mapping: pmap, removeMissing: false }),
  );
  check("the same person is matched on their phone, not duplicated", again.created === 0, `created ${again.created}`);

  // ── 12. The rota ────────────────────────────────────────────────────
  console.log("\n12. Hours, as written on a rota");

  const sh = (s: string) => parseShifts(s);
  const shift1 = (s: string) => (sh(s) as { value: { startTime: string; endTime: string }[] }).value[0];

  check('"9-5" is nine to five, not an inverted day', shift1("9-5")?.endTime === "17:00", JSON.stringify(sh("9-5")));
  check('"10-6" likewise', shift1("10-6")?.endTime === "18:00");
  check('"09:00-17:30" is taken literally', shift1("09:00-17:30")?.endTime === "17:30");
  check('"9am-1pm" respects am/pm', shift1("9am-1pm")?.endTime === "13:00");
  check('"11-2" gains twelve hours on the end', shift1("11-2")?.endTime === "14:00");
  check("an en dash separates as well as a hyphen", shift1("9–5")?.endTime === "17:00");
  check('"9 to 5" reads too', shift1("9 to 5")?.endTime === "17:00");

  check('"off" is no hours, not an error', sh("off").ok && (sh("off") as { value: unknown[] }).value.length === 0);
  check("blank is no hours", (sh("") as { value: unknown[] }).value.length === 0);

  const split = sh("9-1, 2-6") as { value: { startTime: string; endTime: string }[] };
  check("a split shift becomes two blocks", split.value.length === 2, JSON.stringify(split.value));
  check(
    "and the lunch hour between them is not bookable",
    split.value[0].endTime === "13:00" && split.value[1].startTime === "14:00",
    JSON.stringify(split.value),
  );

  check("overlapping halves of a split shift are refused", !sh("9-2, 1-6").ok);
  // 22:00-02:00 cannot be rescued by the twelve-hour rule, and inventing an
  // overnight shift would open a business at three in the morning.
  check("an overnight shift is refused rather than invented", !sh("22-2").ok);
  check("nonsense is refused", !sh("mornings").ok);

  // ── 13. Staff and their week ────────────────────────────────────────
  console.log("\n13. Importing people and the hours they work");

  const rota = toRecords(
    parseCsv(
      "Name,Skills,Mon,Tue,Wed,Thu,Fri,Sat,Sun\n" +
        'Priya,"Hair, Colour",9-5,9-5,off,9-5,"9-1, 2-6",10-4,off\n' +
        "Chair 2,Hair,9-6,9-6,9-6,9-6,9-6,off,off\n",
    ),
  );
  const rmap = {
    Name: "name",
    Skills: "tags",
    Mon: "hoursMon",
    Tue: "hoursTue",
    Wed: "hoursWed",
    Thu: "hoursThu",
    Fri: "hoursFri",
    Sat: "hoursSat",
    Sun: "hoursSun",
  };

  const staff1 = await withTenant(t, (db) =>
    applySheet(db, { tenantId: t, kind: "staff", currency: "GBP", sheet: rota, mapping: rmap, removeMissing: false }),
  );
  check("both people were created", staff1.created === 2, `created ${staff1.created}`);

  const priya = await adminDb.resource.findFirstOrThrow({ where: { tenantId: t, name: "Priya" } });
  check("skills became tags", priya.tags.join(",") === "Hair,Colour", priya.tags.join(","));

  const priyaRules = await adminDb.scheduleRule.findMany({
    where: { tenantId: t, resourceId: priya.id },
    orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
  });
  // Mon, Tue, Thu, Sat = 1 each; Fri = 2 (split shift). Wed and Sun are off.
  check("one rule per shift, and none for days off", priyaRules.length === 6, `${priyaRules.length} rules`);
  check(
    "Wednesday has no hours at all",
    !priyaRules.some((r) => r.weekday === 3),
  );
  const friday = priyaRules.filter((r) => r.weekday === 5);
  check("Friday is two blocks around lunch", friday.length === 2, JSON.stringify(friday.map((r) => `${r.startTime}-${r.endTime}`)));

  check(
    "everyone was attached to the only location",
    (await adminDb.resourceLocation.count({ where: { tenantId: t, resourceId: priya.id } })) === 1,
  );

  const staff2 = await withTenant(t, (db) =>
    applySheet(db, { tenantId: t, kind: "staff", currency: "GBP", sheet: rota, mapping: rmap, removeMissing: false }),
  );
  check("re-running an unchanged rota changes nothing", staff2.updated === 0 && staff2.created === 0,
    `created ${staff2.created}, updated ${staff2.updated}`);
  check(
    "and does not pile up duplicate rules",
    (await adminDb.scheduleRule.count({ where: { tenantId: t, resourceId: priya.id } })) === 6,
  );

  // ── 14. A rota is replaced, not merged ──────────────────────────────
  console.log("\n14. Changing the rota");

  const newRota = toRecords(
    parseCsv("Name,Skills,Mon,Tue,Wed,Thu,Fri,Sat,Sun\n" + 'Priya,"Hair, Colour",9-5,off,off,off,off,off,off\n'),
  );
  const staff3 = await withTenant(t, (db) =>
    applySheet(db, { tenantId: t, kind: "staff", currency: "GBP", sheet: newRota, mapping: rmap, removeMissing: false }),
  );
  check("the change was noticed", staff3.updated === 1, `updated ${staff3.updated}`);
  check(
    "days removed from the sheet stop being offered",
    (await adminDb.scheduleRule.count({ where: { tenantId: t, resourceId: priya.id } })) === 1,
    "a merge rather than a replace would leave Tuesday behind",
  );

  const undoRota = await withTenant(t, (db) => revertRun(db, { tenantId: t, undo: staff3.undo }));
  check("undoing puts the whole week back", undoRota.restored === 1, JSON.stringify(undoRota));
  check(
    "all six shifts again",
    (await adminDb.scheduleRule.count({ where: { tenantId: t, resourceId: priya.id } })) === 6,
  );

  // ── 15. Two locations force the question ────────────────────────────
  console.log("\n15. When there is more than one branch");

  await adminDb.location.create({ data: { tenantId: t, name: "Second", timezone: "Europe/London" } });
  const ambiguous = await withTenant(t, (db) =>
    applySheet(db, { tenantId: t, kind: "staff", currency: "GBP", sheet: rota, mapping: rmap, removeMissing: false }),
  );
  check(
    "a rota with no branch column is refused rather than guessed",
    ambiguous.skipped === 2 && ambiguous.issues.some((i) => i.problem.includes("which one")),
    JSON.stringify(ambiguous.issues.slice(0, 1)),
  );

  // ── Clean up ────────────────────────────────────────────────────────
  await adminDb.tenant.delete({ where: { id: t } });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(async (err) => {
    console.error(err);
    await adminDb.tenant.deleteMany({ where: { slug: SLUG } }).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await adminDb.$disconnect();
    redis.disconnect();
  });
