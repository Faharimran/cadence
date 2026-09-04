/**
 * How the industries section asks the demo panel to change tabs.
 *
 * Both are client components with their own state, sitting in different parts
 * of the page. Lifting the selection into a shared provider would put the whole
 * marketing page behind a client boundary for the sake of one link, and passing
 * a setter down would couple two sections that otherwise know nothing about
 * each other. A window event is the smallest thing that works: the industries
 * section fires and forgets, and if the demo panel is not rendered — an
 * unconfigured deployment, a future page without it — nothing listens and
 * nothing breaks.
 */
export const SELECT_DEMO_EVENT = "cadence:select-demo";

export type SelectDemoDetail = { persona: string };
