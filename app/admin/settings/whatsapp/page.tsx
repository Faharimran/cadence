import Link from "next/link";
import { createHmac } from "node:crypto";
import { requireUser, asTenant, can } from "@/lib/auth/guard";
import { decrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { describeInstant } from "@/lib/engine/time";
import { WhatsAppForm } from "../forms";
import { CopyBox } from "./CopyBox";
import { TestConnection } from "./TestConnection";
import { BackLink, Empty, Notice, PageHeader, Pill, Section } from "../../ui";

export const dynamic = "force-dynamic";

/**
 * How to connect WhatsApp, written for whoever actually has to do it.
 *
 * That person runs a clinic or a barber shop. They have never seen a developer
 * console, and Meta's own instructions assume they have. So this page names
 * every button they will click, in the order they will click it, and puts the
 * fields they are pasting into on the SAME page — switching windows with a
 * secret on the clipboard is where these setups get abandoned.
 *
 * Three deliberate choices:
 *
 *  · The verify token is generated for them. It is the one value that is theirs
 *    to invent, and "make up a random string" stops people who are already out
 *    of their depth.
 *  · The webhook address is shown ready to copy, not described.
 *  · If that address is a local one, the page says so loudly. Meta cannot reach
 *    localhost, and a person who does not know that will follow every step
 *    correctly and still fail, with nothing to tell them why.
 */
export default async function WhatsAppGuidePage() {
  const user = await requireUser();

  // The most recent send failure, if there is one worth mentioning.
  //
  // Until this existed, an expired access token presented as customers simply
  // not being answered: the assistant wrote a perfectly good reply, Meta refused
  // it, and the only record was a line in the server log. Nobody was going to
  // read that. Whoever runs the business is the person who can fix it, and this
  // is the page they would fix it on.
  const { channel, recentFailure } = await asTenant(user, async (db) => {
    const channel = await db.channelAccount.findFirst({
      where: { tenantId: user.tenantId, channel: "whatsapp" },
    });
    const recentFailure = await db.conversationMessage.findFirst({
      where: {
        tenantId: user.tenantId,
        direction: "outbound",
        status: "failed",
        failureReason: { not: null },
        // A week, not all time. A failure from three months ago that was fixed
        // the same day is not news, and a banner that is always on is a banner
        // nobody reads.
        createdAt: { gt: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      select: { failureReason: true, createdAt: true },
    });
    return { channel, recentFailure };
  });

  const base = env.CADENCE_BASE_URL.replace(/\/$/, "");
  const callbackUrl = `${base}/api/webhooks/whatsapp`;
  const looksLocal = /localhost|127\.0\.0\.1|\.local(:|$)/i.test(base);

  // Derived from the tenant, NOT random per visit.
  //
  // The first version generated a fresh one on every load, which is a trap: you
  // copy it into Meta, come back, the page has re-rendered with a different one,
  // you save that — and verification fails with nothing to indicate why. The
  // suggestion has to survive a reload because the flow requires leaving the
  // page and returning.
  //
  // HMAC over the tenant id rather than a stored column: stable, unique per
  // business, and unguessable without CADENCE_SECRET. It is only a suggestion —
  // whatever they actually save is what counts.
  const suggestedToken = `cadence-${createHmac("sha256", env.CADENCE_SECRET)
    .update(`whatsapp-verify:${user.tenantId}`)
    .digest("hex")
    .slice(0, 18)}`;

  const connected = Boolean(channel?.accessToken && channel.active);
  const isOwner = can(user, "owner");
  const isManager = can(user, "manager");

  /**
   * The saved verify token, shown back to the owner.
   *
   * A deliberate exception to "secrets are never shown again". This is the one
   * value that has to be typed identically into two systems, and when it does
   * not match, Meta says only "the callback URL or verify token couldn't be
   * validated" — naming neither. With nothing on this page to compare against,
   * the mismatch is invisible and the product looks broken. That cost is real
   * and the exposure is not: unlike the app secret and the access token, this
   * one grants nothing. It is a nonce for a single setup handshake, useless to
   * anybody who is not Meta calling this exact URL.
   *
   * Owner-only, like the form it sits above.
   */
  let savedVerifyToken: string | null = null;
  if (isOwner && channel?.verifyToken) {
    try {
      savedVerifyToken = decrypt(channel.verifyToken);
    } catch {
      // Undecryptable means the encryption key changed since it was saved.
      // Leaving it null falls through to offering a fresh suggestion, which is
      // the right recovery — they have to re-enter it either way.
      savedVerifyToken = null;
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <BackLink href="/admin/settings">settings</BackLink>
        <PageHeader
          title="Connect WhatsApp"
          lede="This is the one setup step that happens outside cadence. It takes about fifteen minutes, you only do it once, and everything you need to copy is on this page."
        />
        <div className="flex flex-wrap items-center gap-2">
          {connected ? (
            <Pill tone="ok">connected</Pill>
          ) : channel ? (
            <Pill tone="warn">started, not finished</Pill>
          ) : (
            <Pill tone="warn">not connected</Pill>
          )}
          {channel?.displayNumber && (
            <span className="num text-[11px] text-ink-3">{channel.displayNumber}</span>
          )}
        </div>
      </div>

      {/* Above everything, including the setup guide. Someone arriving here
          because their customers stopped getting replies needs the reason
          first, not fifteen minutes of instructions they already followed. */}
      {recentFailure && (
        <Notice tone="bad" title="A reply to a customer could not be sent">
          <p className="max-w-[70ch]">{recentFailure.failureReason}</p>
          <p className="num mt-1.5 text-[11px] opacity-80">
            most recently {describeInstant(recentFailure.createdAt, user.tenantTimezone)}
          </p>
        </Notice>
      )}

      {looksLocal && (
        <Notice tone="bad" title="Stop — this address only works on this computer.">
          <p className="max-w-[70ch]">
            Your webhook address is currently{" "}
            <code className="font-mono text-[12px]">{base}</code>. WhatsApp has to be able to reach
            enori over the internet, and it cannot reach an address like that. Every step below
            will appear to work and no message will ever arrive.
          </p>
          <p className="mt-1.5 max-w-[70ch]">
            Ask whoever set enori up for you to give it a public web address first. Nothing else
            on this page will help until they have.
          </p>
        </Notice>
      )}

      {/* ── What you need before starting ──────────────────────────── */}
      <Section title="Before you start" boxed>
        <ul className="flex max-w-[72ch] list-disc flex-col gap-2 pl-5 text-sm text-ink-2">
          <li>
            A <strong>Facebook account</strong>. A personal one is fine — it is only used to sign
            in to Meta&apos;s business tools.
          </li>
          <li>
            A <strong>phone number you can receive a text on</strong>, which is not already used
            for a personal WhatsApp account. Meta will send it a code.
          </li>
          <li>
            About <strong>fifteen minutes</strong>. Do not start this five minutes before you need
            to leave — Meta logs you out and you lose your place.
          </li>
        </ul>
        <p className="mt-4 max-w-[72ch] text-[13px] text-ink-3">
          You can also do the whole thing with Meta&apos;s free <em>test number</em> first, without
          registering a real one. A test number can only message people you add to a short list,
          which is exactly what you want while you are trying it.
        </p>
      </Section>

      {/* ── The two values from us ─────────────────────────────────── */}
      <Section title="Two things to copy from here" boxed>
        <p className="mb-4 max-w-[72ch] text-sm text-ink-2">
          Meta is going to ask you for these. Keep this tab open — you will come back for them in
          step 4.
        </p>
        <div className="flex flex-col gap-4">
          <CopyBox label="Callback URL" value={callbackUrl} />
          {savedVerifyToken ? (
            <CopyBox label="Verify token — the one you saved" value={savedVerifyToken} />
          ) : (
            <CopyBox label="Verify token — we made one up for you" value={suggestedToken} />
          )}
        </div>

        {savedVerifyToken && (
          <Callout tone="warn" title="Meta must have this exact text.">
            This is what enori has stored, shown so you can check it against what you typed into
            Meta. If they differ by even one character, Meta reports that the callback URL could
            not be validated — and neither screen tells you which half is wrong.
          </Callout>
        )}
        <p className="mt-3 max-w-[72ch] text-[12px] text-ink-3">
          The verify token is a password you make up. Meta does not care what it says — it exists so
          enori can tell that a webhook call is really yours. Put the <em>same</em> text in both
          places and it will match. It is used once, during setup; after that, messages are checked
          with the app secret instead.
        </p>
        <p className="mt-2 max-w-[72ch] text-[12px] text-ink-3">
          This suggestion stays the same every time you open this page, so you can leave and come
          back without it changing under you. If you have already saved a different one, keep using
          that.
        </p>
      </Section>

      {/* ── The steps ──────────────────────────────────────────────── */}
      <Section title="Step by step">
        <ol className="flex flex-col gap-5">
          <Step n={1} title="Create a Meta app">
            <p>
              Go to{" "}
              <a
                href="https://developers.facebook.com/apps"
                target="_blank"
                rel="noreferrer"
                className="text-accent underline underline-offset-2"
              >
                developers.facebook.com/apps
              </a>{" "}
              and sign in with Facebook. Click <Btn>Create app</Btn>.
            </p>
            <p>
              When it asks what you want your app to do, choose <Btn>Other</Btn>, then{" "}
              <Btn>Business</Btn> as the type. Give it any name — your clinic&apos;s name is fine.
              Nobody outside your business sees it.
            </p>
          </Step>

          <Step n={2} title="Add WhatsApp to the app">
            <p>
              On your new app&apos;s dashboard, find <strong>WhatsApp</strong> in the list of
              products and click <Btn>Set up</Btn>.
            </p>
            <p>
              It may ask you to create or pick a <em>Business portfolio</em>. If you have never done
              this, create one with your business name and carry on.
            </p>
          </Step>

          <Step n={3} title="Copy three values from Meta">
            <p>
              You are now on the <strong>API Setup</strong> page. Three of the things you need are
              on this one screen:
            </p>
            <Table
              rows={[
                [
                  "Phone number ID",
                  "Under “Send and receive messages”. It is a long number. Do NOT copy the phone number itself — you want the ID underneath it.",
                ],
                [
                  "Temporary access token",
                  "At the top of the same page. Click to reveal, then copy. It expires in 24 hours, which is fine for testing — see the note at the bottom about making it permanent.",
                ],
                [
                  "App secret",
                  "This one is elsewhere: left menu → App settings → Basic → App secret → Show.",
                ],
              ]}
            />
            <p className="text-ink-3">
              Paste each one into the form at the bottom of this page as you go, so you are not
              holding three secrets in your head at once.
            </p>
          </Step>

          <Step n={4} title="Tell Meta where to send messages">
            <p>
              In the left menu under WhatsApp, click <Btn>Configuration</Btn>. Next to{" "}
              <strong>Webhook</strong>, click <Btn>Edit</Btn>.
            </p>
            <p>Paste the two values from the box above:</p>
            <Table
              rows={[
                ["Callback URL", callbackUrl],
                ["Verify token", "the token from the box above"],
              ]}
            />
            <p>
              Click <Btn>Verify and save</Btn>. Meta immediately calls enori to check the token
              matches.
            </p>
            <Callout tone="ok" title="If it saves without an error, that half is done.">
              You must have saved the verify token in the form below <em>first</em> — Meta is
              checking it against what enori has stored. If you have not, save the form, then come
              back and press Verify and save again.
            </Callout>
          </Step>

          <Step n={5} title="Subscribe to messages">
            <p>
              Still on the Configuration page, under <strong>Webhook fields</strong>, find{" "}
              <strong>messages</strong> and click <Btn>Subscribe</Btn>.
            </p>
            <Callout tone="warn" title="This is the step people miss.">
              The webhook can be verified and green and still deliver nothing, because Meta does not
              send anything until you subscribe to a field. If messages never arrive, check this
              first.
            </Callout>
          </Step>

          <Step n={6} title="Add your own number to test with">
            <p>
              Back on <strong>API Setup</strong>, find the <strong>To</strong> box and click{" "}
              <Btn>Manage phone number list</Btn>. Add your own mobile number and confirm the code
              Meta sends you.
            </p>
            <p className="text-ink-3">
              While you are using a test number, Meta will only deliver to numbers on this list.
              This is a Meta restriction, not a enori one.
            </p>
          </Step>

          <Step n={7} title="Send a message and watch it work">
            <p>
              From your own phone, message the WhatsApp number shown on the API Setup page. Ask it
              something your business has written down — try{" "}
              <em>&ldquo;what are your opening hours?&rdquo;</em>
            </p>
            <p>
              The reply should arrive within a few seconds. Whether it does or not, the conversation
              will appear in{" "}
              <Link href="/admin/conversations" className="text-accent underline underline-offset-2">
                Conversations
              </Link>
              , so you can see exactly what was received and what was said back.
            </p>
          </Step>
        </ol>
      </Section>

      {/* ── The form ───────────────────────────────────────────────── */}
      <Section title="Paste them here" boxed>
        {isOwner ? (
          <WhatsAppForm
            existing={
              channel
                ? {
                    externalAccountId: channel.externalAccountId,
                    displayNumber: channel.displayNumber,
                    hasToken: Boolean(channel.accessToken),
                  }
                : null
            }
          />
        ) : (
          <Empty>
            Only the account owner can save these. Ask whoever set up your enori account.
          </Empty>
        )}
      </Section>

      {/* ── Is it actually working right now ───────────────────────── */}
      {channel?.accessToken && isManager && (
        <Section title="Check it still works" boxed>
          <p className="mb-4 max-w-[72ch] text-sm text-ink-2">
            Access tokens expire — Meta&apos;s test tokens last only a day. When one does, the
            assistant carries on writing replies and WhatsApp quietly refuses to deliver them, so
            the first sign is usually a customer saying they never heard back. This asks WhatsApp
            directly instead of waiting to find out.
          </p>
          <TestConnection />
        </Section>
      )}

      {/* ── The token that does not expire ─────────────────────────── */}
      {/* Placed straight after the connection check, because that is where
          someone lands the morning their replies stopped, and "do this once and
          it never happens again" is the only thing they want to read. */}
      {isOwner && (
        <Section title="Stop having to do this every day" boxed>
          <p className="max-w-[72ch] text-sm text-ink-2">
            The token on the API Setup page is a <strong>temporary</strong> one. It lasts about
            twenty-four hours, and when it dies your assistant keeps writing replies that WhatsApp
            silently refuses to deliver. Nobody is told. The first sign is a customer saying they
            never heard back.
          </p>
          <p className="mt-3 max-w-[72ch] text-sm text-ink-2">
            A <strong>System User</strong> token never expires. It takes about ten minutes to set up
            once, in a corner of Meta&apos;s settings that is genuinely hard to find, and then you
            never think about it again.
          </p>

          <ol className="mt-6 flex flex-col gap-3">
            <Step n={1} title="Open Business Settings — not the app dashboard">
              <p>
                Go to{" "}
                <a
                  href="https://business.facebook.com/settings"
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline underline-offset-2"
                >
                  business.facebook.com/settings
                </a>
                . This is a different place from the developer dashboard where you got the
                temporary token, which is the main reason people cannot find this.
              </p>
              <p className="text-ink-3">
                If you are asked to pick a business, choose the one your WhatsApp number belongs to.
              </p>
            </Step>

            <Step n={2} title="Create a System User">
              <p>
                In the left menu, under <strong>Users</strong>, click <strong>System users</strong>,
                then <strong>Add</strong>. Name it something you will recognise later — “enori”
                is fine — and set the role to <strong>Admin</strong>.
              </p>
            </Step>

            <Step n={3} title="Give it your app and your WhatsApp account">
              <p>
                With the new system user selected, click <strong>Add assets</strong>. You need to do
                this <em>twice</em>, and missing the second one is the usual reason the finished
                token does not work:
              </p>
              <p>
                Under <strong>Apps</strong>, pick your app and turn on{" "}
                <strong>Manage app</strong>. Then click <strong>Add assets</strong> again, go to{" "}
                <strong>WhatsApp accounts</strong>, pick your account and turn on{" "}
                <strong>Manage</strong>.
              </p>
            </Step>

            <Step n={4} title="Generate the token">
              <p>
                Click <strong>Generate new token</strong>. Choose your app, then set{" "}
                <strong>Token expiration</strong> to <strong>Never</strong> — this is the whole
                point, and it is easy to skip past.
              </p>
              <p>
                Tick exactly two permissions: <strong>whatsapp_business_messaging</strong> and{" "}
                <strong>whatsapp_business_management</strong>. Nothing else is needed, and a token
                can only do what you tick.
              </p>
            </Step>

            <Step n={5} title="Copy it now — you cannot see it again">
              <p>
                Meta shows the token once. Copy it, paste it into the{" "}
                <strong>Access token</strong> field above, and press Save. Leave every other field
                alone; the phone number ID, app secret and verify token are unchanged.
              </p>
              <p>
                Then press <strong>Check the connection</strong> above. It should say your business
                name and number back to you.
              </p>
            </Step>
          </ol>

          <p className="mt-5 max-w-[72ch] text-[13px] leading-relaxed text-ink-3">
            If <strong>System users</strong> is not in your menu, your WhatsApp number is attached
            to a personal developer account rather than a business one. Meta requires a Business
            account for permanent tokens — you can create one from the same settings page, and your
            existing app and number can be moved into it.
          </p>
        </Section>
      )}

      {/* ── When it goes wrong ─────────────────────────────────────── */}
      <Section title="If something is not working">
        <dl className="flex max-w-[76ch] flex-col gap-4 text-sm">
          {[
            [
              "Meta says the callback URL could not be verified",
              "Nine times out of ten the verify token in the form here does not match the one you typed into Meta. Save it here first, then press Verify and save at Meta. Check for a space at the start or end.",
            ],
            [
              "It verified, but no messages arrive",
              "You almost certainly have not subscribed to the messages field (step 5). Go back to Configuration and check.",
            ],
            [
              "Messages arrive but nothing is sent back",
              "Usually an expired access token — the temporary one lasts 24 hours. Generate a new one on the API Setup page and paste it in again. Open the conversation in Conversations: if you can see the customer's message but no reply, this is why.",
            ],
            [
              "The assistant replies but says it will check with a colleague",
              "That is it working correctly with nothing to say. It only repeats what you have approved in What you tell customers — if that is empty, every question goes to a person.",
            ],
            [
              "You get a reply but your customers do not",
              "While you are on a test number, Meta only delivers to numbers on the allowed list (step 6). Registering a real business number removes that limit.",
            ],
          ].map(([q, a]) => (
            <div key={q}>
              <dt className="font-semibold">{q}</dt>
              <dd className="mt-1 text-ink-2">{a}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {/* ── Afterwards ─────────────────────────────────────────────── */}
      <Section title="Once it is working" boxed>
        <div className="flex max-w-[76ch] flex-col gap-4 text-sm text-ink-2">
          <p>
            <strong className="text-ink">Make the access token permanent.</strong> The one from API
            Setup expires after 24 hours and the assistant will go quiet when it does. In Meta:
            Business settings → Users → System users → add one with admin access to your WhatsApp
            account, then generate a token for it and paste that in above. It does not expire.
          </p>
          <p>
            <strong className="text-ink">Meta&apos;s 24-hour rule.</strong> A business may only send
            a free message within 24 hours of the customer&apos;s last one. Since customers always
            message first, this rarely matters — but it is why a reply to a very old thread may not
            deliver.
          </p>
          <p>
            <strong className="text-ink">Your keys are stored encrypted</strong> and are never shown
            again after saving. If you lose one, generate a new one at Meta and paste it in.
          </p>
        </div>
      </Section>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  Small pieces
// ══════════════════════════════════════════════════════════════════════

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4 rounded-2xl border border-rule bg-surface p-5">
      <span
        aria-hidden
        className="num grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-bold text-on-accent"
        style={{ background: "var(--accent)" }}
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        <div className="flex max-w-[72ch] flex-col gap-2 text-sm leading-relaxed text-ink-2">
          {children}
        </div>
      </div>
    </li>
  );
}

/** A button you click in Meta's interface, named exactly as it appears there. */
function Btn({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-ink">
      {children}
    </span>
  );
}

function Table({ rows }: { rows: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-b border-rule/60 align-top">
              <th className="whitespace-nowrap py-2 pr-4 text-left font-semibold text-ink">{k}</th>
              <td className="py-2 text-ink-2">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The page's own callout, now a thin wrapper over the shared notice.
 *
 * It kept its own colours until the system grew a banner of its own — which is
 * exactly how a product ends up with two greens that are nearly the same and no
 * way to tell which one means "done".
 */
function Callout({
  tone,
  title,
  children,
}: {
  tone: "ok" | "warn";
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <Notice tone={tone === "ok" ? "good" : "warn"}>
      <strong>{title}</strong> <span className="opacity-90">{children}</span>
    </Notice>
  );
}
