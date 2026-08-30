export const dynamic = "force-dynamic";

/**
 * The right pane before a thread is chosen.
 *
 * The list beside it is rendered by the layout, so this is only ever the empty
 * half — which is why it says what to do rather than apologising for being
 * blank.
 */
export default function NoThreadSelected() {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <p className="max-w-[34ch] text-sm text-ink-2">
        Pick a conversation on the left to read it, reply by hand, or take it off the assistant.
      </p>
    </div>
  );
}
