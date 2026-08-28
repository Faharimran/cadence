import type { TenantDb } from "@/lib/prisma";

/**
 * Can this business actually take a booking yet?
 *
 * Written for the person at the front desk, not the person who built this. Every
 * message names the thing they recognise ("nobody has opening hours") rather
 * than the thing the schema calls it ("no ScheduleRule rows"), and every step
 * links to the one screen that fixes it.
 *
 * The order is a dependency order, not a menu: services need locations, hours
 * need people, and none of it matters until something can be booked. Presenting
 * nine screens and letting someone guess is how a setup gets abandoned halfway.
 */

export type Step = {
  id: string;
  title: string;
  /** What is left to do, in their words. Absent when the step is done. */
  todo?: string;
  href: string;
  done: boolean;
  /** False for steps that are useful but not required to take a booking. */
  required: boolean;
};

export type Readiness = {
  steps: Step[];
  /** True when a customer could message in right now and be booked. */
  canTakeBookings: boolean;
  /** Everything required is done. */
  complete: boolean;
  doneCount: number;
  requiredCount: number;
};

export async function assessReadiness(db: TenantDb, tenantId: string): Promise<Readiness> {
  const [locations, resources, services, rules, channel, exceptionTypes] = await Promise.all([
    db.location.count({ where: { tenantId, active: true } }),
    db.resource.findMany({
      where: { tenantId, active: true },
      select: { id: true, name: true, _count: { select: { scheduleRules: true } } },
    }),
    db.service.findMany({
      where: { tenantId, active: true },
      select: { id: true, name: true, requirements: { select: { id: true } } },
    }),
    db.scheduleRule.count({ where: { tenantId, effectiveTo: null } }),
    db.channelAccount.findFirst({
      where: { tenantId, channel: "whatsapp", active: true },
      select: { accessToken: true },
    }),
    db.exceptionType.count({ where: { tenantId, active: true } }),
  ]);

  const withoutHours = resources.filter((r) => r._count.scheduleRules === 0);
  const withoutRequirements = services.filter((s) => s.requirements.length === 0);

  const steps: Step[] = [
    {
      id: "locations",
      title: "Add where you work",
      href: "/admin/settings",
      done: locations > 0,
      required: true,
      todo: locations === 0 ? "Add at least one branch, with its timezone." : undefined,
    },
    {
      id: "resources",
      title: "Add your people and rooms",
      href: "/admin/resources",
      done: resources.length > 0,
      required: true,
      todo: resources.length === 0 ? "Add the people customers book time with." : undefined,
    },
    {
      id: "services",
      title: "Say what you offer",
      href: "/admin/services",
      done: services.length > 0 && withoutRequirements.length === 0,
      required: true,
      todo:
        services.length === 0
          ? "Add what customers can book, and how long each takes."
          : withoutRequirements.length > 0
            ? `${listNames(withoutRequirements)} ${plural(withoutRequirements.length, "does", "do")} not say who can do it.`
            : undefined,
    },
    {
      id: "hours",
      title: "Set your opening hours",
      href: "/admin/schedules",
      done: rules > 0 && withoutHours.length === 0,
      required: true,
      todo:
        rules === 0
          ? "Nobody has hours yet, so there are no times to offer."
          : withoutHours.length > 0
            ? `${listNames(withoutHours)} ${plural(withoutHours.length, "has", "have")} no hours, so ${plural(withoutHours.length, "they are", "they are")} never offered.`
            : undefined,
    },
    {
      id: "timeoff",
      title: "Name your kinds of time off",
      href: "/admin/settings",
      done: exceptionTypes > 0,
      required: false,
      todo:
        exceptionTypes === 0
          ? "Add the words you use — leave, closed, theatre day — so staff can record them."
          : undefined,
    },
    {
      id: "whatsapp",
      title: "Connect WhatsApp",
      href: "/admin/settings",
      done: Boolean(channel?.accessToken),
      required: false,
      todo: !channel
        ? "Not connected yet. Everything else works without it — customers just cannot message you."
        : !channel.accessToken
          ? "Connected, but the access token is missing."
          : undefined,
    },
  ];

  const required = steps.filter((s) => s.required);

  return {
    steps,
    // Deliberately narrower than "all steps done": WhatsApp is how customers
    // reach you, but the API can take bookings without it.
    canTakeBookings: required.every((s) => s.done),
    complete: required.every((s) => s.done),
    doneCount: required.filter((s) => s.done).length,
    requiredCount: required.length,
  };
}

function listNames(items: { name: string }[], max = 3): string {
  const names = items.slice(0, max).map((i) => i.name);
  const rest = items.length - names.length;
  const joined =
    names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return rest > 0 ? `${joined} and ${rest} more` : joined;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
