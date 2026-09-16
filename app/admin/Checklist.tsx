import Link from "next/link";
import type { Readiness } from "@/lib/readiness";
import { Icon } from "@/app/icons";

/**
 * The setup checklist.
 *
 * Shown until a business can actually take a booking, then reduced to a quiet
 * line. A checklist that never goes away stops being read; one that disappears
 * the moment it is satisfied is a signal rather than furniture.
 */
export function Checklist({ readiness }: { readiness: Readiness }) {
  const { steps, canTakeBookings, doneCount, requiredCount } = readiness;
  const outstanding = steps.filter((s) => !s.done);

  if (canTakeBookings && outstanding.length === 0) return null;

  return (
    <section className="card flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-semibold text-ink">
          {canTakeBookings ? "A few things left" : "Finish setting up"}
        </h2>
        <span className="num text-[11px] text-ink-3">
          {doneCount} of {requiredCount} essentials done
        </span>
      </div>

      <p className="max-w-[62ch] text-sm text-ink-2">
        {canTakeBookings
          ? "You can take bookings. The rest is optional, but worth doing."
          : "Until these are done, the assistant has no times it can offer anyone."}
      </p>

      <ol className="flex flex-col gap-1.5">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-3">
            {/* Drawn, not typed. ✓ and ○ are two of the characters that render
                as a coloured emoji on some platforms and a hairline on others,
                so a list of them is a list in two different weights. */}
            <Icon
              name={step.done ? "check" : "circle"}
              size={14}
              className={`mt-[3px] shrink-0 ${step.done ? "txt-good" : "text-ink-faint"}`}
            />

            <div className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className={step.done ? "text-ink-3 line-through" : ""}>{step.title}</span>
                {!step.required && !step.done && (
                  <span className="eyebrow">optional</span>
                )}
              </span>

              {step.todo && (
                <span className="text-xs text-ink-2">
                  {step.todo}{" "}
                  <Link
                    href={step.href}
                    className="text-accent underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    Do it
                  </Link>
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
