/**
 * Runs a real sheet through the whole import pipeline and prints what would
 * happen, without writing anything.
 *
 * For the question that comes up whenever a business says "it read my sheet
 * wrong": what did we actually see, and what did we think each column was. The
 * answer needs their real file, and reproducing it by reading the code is
 * slower and less reliable than just running it.
 *
 * Writes nothing to the database.
 *
 * Run: npm run try:import -- <url-or-file> [services|customers] [currency]
 */
import { readFile } from "node:fs/promises";
import { resolveSheetUrl, readSheet, parseCsv, toRecords, SheetError } from "@/lib/imports/sheet";
import { proposeMapping } from "@/lib/imports/map";
import { fieldsFor } from "@/lib/imports/fields";
import { redis } from "@/lib/redis";

async function main() {
  const target = process.argv[2];
  const kind = process.argv[3] ?? "services";
  const currency = process.argv[4] ?? "GBP";

  if (!target) {
    console.error("Usage: npm run try:import -- <url-or-file> [services|customers] [currency]");
    process.exit(1);
  }

  const sheet = /^https?:\/\//i.test(target)
    ? await readSheet(resolveSheetUrl(target).fetchUrl)
    : toRecords(parseCsv(await readFile(target, "utf8")));

  console.log(`\n${"─".repeat(70)}`);
  console.log(`${sheet.rows.length} rows · ${sheet.headers.length} columns · reading as ${kind}`);
  console.log("─".repeat(70));
  console.log(`\nHeadings: ${sheet.headers.join(" | ")}`);
  console.log(`\nFirst row: ${JSON.stringify(sheet.rows[0], null, 2)}`);

  const proposal = await proposeMapping({
    kind,
    headers: sheet.headers,
    sample: sheet.rows,
    currency,
  });

  console.log(`\nMapped by: ${proposal.source === "model" ? "the model" : "column names only"}`);
  console.log("─".repeat(70));

  const labels = new Map(fieldsFor(kind).map((f) => [f.key, f.label]));
  for (const header of sheet.headers) {
    const field = proposal.mapping[header];
    const doubt = proposal.uncertain.find((u) => u.header === header);
    console.log(
      `  ${header.padEnd(24)} → ${field ? labels.get(field) ?? field : "(not imported)"}` +
        (doubt ? `   ⚠ ${doubt.note}` : ""),
    );
  }

  if (proposal.missing.length > 0) {
    console.log(
      `\n  ✗ nothing mapped to: ${proposal.missing.map((m) => labels.get(m) ?? m).join(", ")}`,
    );
    console.log("    The import would refuse until a person sets these.");
  } else {
    console.log("\n  ✓ every required field has a column");
  }
  console.log("─".repeat(70));
}

main()
  .catch((err) => {
    console.error(err instanceof SheetError ? `${err.message}\n${err.remedy}` : err);
    process.exitCode = 1;
  })
  .finally(() => redis.disconnect());
