import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/guard";
import { env } from "@/lib/env";
import { PRESETS } from "@/lib/presets";
import { SignUpForm } from "./SignUpForm";

export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  // 404 rather than a message: on a deployment that onboards by hand, the route
  // may as well not exist.
  if (env.CADENCE_SIGNUP_OPEN !== "true") notFound();
  if (await currentUser()) redirect("/admin");

  return (
    <main className="mx-auto w-full max-w-lg px-6 py-16">
      <div className="mb-8 flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-3">
          cadence
        </span>
        <h1 className="font-mono text-2xl font-semibold tracking-tight">Set up your business</h1>
        <p className="mt-2 text-sm text-ink-2">
          Takes a minute. You&apos;ll land on a checklist that walks you through the rest.
        </p>
      </div>

      <SignUpForm
        presets={PRESETS.map((p) => ({ id: p.id, label: p.label, blurb: p.blurb }))}
        // A suggestion, not a default — it comes from the server's clock, which
        // is right often enough to save typing and wrong often enough that the
        // field stays editable and required.
        suggestedTimezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      />

      <p className="mt-8 text-sm text-ink-2">
        Already set up?{" "}
        <Link href="/signin" className="text-accent underline underline-offset-2">
          Sign in
        </Link>
        .
      </p>
    </main>
  );
}
