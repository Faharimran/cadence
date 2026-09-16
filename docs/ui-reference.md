# enori UI reference — a portable design system

**What this is.** A complete, self-contained specification of the enori interface,
written to be handed to a different project. Everything needed to reproduce the look
is here as literal values; nothing refers back to the codebase it came from.

**How to use it.** Paste this whole file into a session working on the other product
and say *"build the UI to this reference."* The CSS block in §2 is copy-pasteable as-is
— it is the actual token set, not a paraphrase.

**What it is for.** A dense, information-heavy B2B web application: tables read all day,
operational dashboards, records with status. It is calibrated for people who live in the
software, not for a marketing site. If the target product is a landing page, take the
palette and ignore the density.

---

## 1. The five rules

Everything below follows from these. If you only keep one page, keep this one.

1. **Colour lives in tokens, never in components.** Every value in §2 is a CSS custom
   property. Components reference roles (`var(--surface)`), never hex. This is the
   difference between changing the palette in ten minutes and changing it in forty files.
2. **Status needs three channels, not one.** Every badge carries a **fill, an ink colour
   and a drawn glyph**. A state must survive greyscale, colour blindness and a printed
   page — none of which a block of colour does.
3. **One accent, used rarely.** The brand blue appears on the active nav item, the single
   primary button on a screen, and the one chart mark worth naming. A second filled thing
   competing with the primary action means neither wins.
4. **No emoji in the interface.** They are drawn by the operating system, so the same
   character is a different picture on macOS, Windows, Android and Linux — and several
   dingbats (`☎`, `☀`, `⚠`) switch to emoji presentation on their own. Use inline SVG.
5. **Contrast is measured, not judged.** 4.5:1 for body text, 3:1 for large text and UI
   boundaries. Every pair in this document has been checked; where a source reference
   failed, the value was changed and the reason recorded.

---

## 2. Tokens — copy this block

```css
:root {
  /* Surfaces: a near-white ground with white cards on it. The tonal step between
     them is what separates a card from the page — no shadow needed. */
  --surface-page:    #f5f6f8;
  --surface-card:    #ffffff;
  --surface-sunken:  #eef0f4;   /* inset fills, table headers, hover grounds */

  /* Rules. Hairlines; the ground does most of the separating. */
  --rule:            #e6e8ee;
  --rule-strong:     #d2d6e0;   /* hover borders, emphasis */
  --rule-soft:       #eff1f5;

  /* Ink */
  --ink:             #14161d;   /* all headings and primary text */
  --ink-soft:        #363b47;
  --ink-muted:       #6b7280;   /* secondary text, nav at rest */
  --ink-faint:       #9aa1ad;   /* timestamps, captions, placeholders */

  /* Accent — one colour, used sparingly. White measures 5.65:1 against it, so it
     can carry a full-height nav as a flat field AND fill a button. */
  --accent:          #3358e8;
  --accent-deep:     #2a46c4;   /* hover, and accent-coloured text on white */
  --accent-wash:     #e8edfd;   /* active nav item, soft fills */
  --accent-light:    #7f9bf2;

  /* Radius — tight. Larger radii read as consumer software. */
  --r-sm:  8px;    /* inputs, small controls */
  --r:     10px;   /* cards, panels */
  --r-lg:  14px;   /* large containers */
  --pill:  999px;

  /* Charts. The many sit back; only the mark that matters is saturated. */
  --viz-bar:      #97aef2;
  --viz-bar-peak: #3358e8;
  --viz-grid:     var(--rule);
  --viz-seq-1:    #2440b8;   /* sequential ramp, darkest = largest */
  --viz-seq-2:    #3358e8;
  --viz-seq-3:    #6b8af0;
  --viz-seq-4:    #a5b9f7;
  --viz-seq-5:    #d8e1fc;
}

/* Dark mode is SELECTED, not inverted — its own steps, checked against its own
   ground. A programmatic flip of a light palette always produces mud. */
:root[data-theme="dark"] {
  --surface-page:    #0f1220;
  --surface-card:    #181d31;
  --surface-sunken:  #222842;
  --rule:            #2b3252;
  --rule-strong:     #3b4468;
  --rule-soft:       #212743;
  --ink:             #f5f6f8;
  --ink-soft:        #d2d6e0;
  --ink-muted:       #9aa1b5;
  --ink-faint:       #6d7590;
  --accent:          #6b8af0;
  --accent-deep:     #a5b9f7;
  --accent-wash:     #1d2547;
  --viz-bar:         #3a4a86;
  --viz-bar-peak:    #8ba5f5;
  --viz-seq-1:       #d8e1fc;
  --viz-seq-2:       #a5b9f7;
  --viz-seq-3:       #6b8af0;
  --viz-seq-4:       #3358e8;
  --viz-seq-5:       #2440b8;
}
```

---

## 3. Type

**Two families. Not three.** Every extra face is another render-blocking request for
nothing a reader can name.

| Role | Family |
|---|---|
| Interface — everything | **Plus Jakarta Sans** (400 / 500 / 600 / 700) |
| Logotype and display only | **Playfair Display** (500 / 600 / 700) |

### Scale

Small, deliberately. This is for software people work in, where fitting one more row on
screen is worth more than a generous headline.

| Element | Size | Weight |
|---|---|---|
| Body, table cells | **13px** / 1.5 | 400 |
| h1 / page title | 19px | 600 |
| h2 / card title | 15px | 600 |
| h3 | 14px | 600 |
| Section label ("eyebrow") | 10px, `letter-spacing: 1.2px`, uppercase | 600 |
| Nav item | 12.5px | 400 (600 when active) |
| Nav section heading | 9.5px, `letter-spacing: .1em`, uppercase | 600 |
| Table header | 10px, `letter-spacing: .06em`, uppercase | 600 |
| Stat figure | 22px | 600 |
| Hero figure | 27px | 600 |
| Badge / tag | 12px | 600 |
| Caption, timestamp | 10–11px | 400 |

> **Do not scale body text below 13px.** When density is requested, take it from the
> display sizes and the padding — that is where the slack is. A third off the *reading*
> size produces a denser screenshot and an unusable product.

**Numerals:** `font-variant-numeric: tabular-nums` on every figure, counter, timer and
currency value. Without it, digits change width as they change and the column jitters.

---

## 4. Status tags — the heart of the system

Status badges answer **different questions** — is this a duplicate, has this person opted
out, is it held, does it need a human. Different questions need different answers, and
**one hue cannot give four answers.**

> **This was measured, not argued.** Six hues taken from a single blue/violet band put the
> worst adjacent pair at **ΔE 5.6 for normal colour vision**, against a floor of 15 — two
> badges most people cannot tell apart, before colour blindness enters into it. The
> palette below clears it at **15.2 for normal vision and 15.3 for the worst
> colour-blind pair.** If you narrow this palette, re-measure it.

### Anatomy

```css
.tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  border-radius: 8px;
  background-color: var(--tag-fill);
  /* the gloss: white falling off the top edge */
  background-image: linear-gradient(180deg, rgba(255,255,255,.55), rgba(255,255,255,0) 60%);
  color: var(--tag-ink);
  box-shadow: 0 1px 2px rgba(20,22,29,.10);
  font-size: 12px;
  font-weight: 600;
  line-height: 17px;
  text-transform: lowercase;
  white-space: nowrap;
}
.tag-icon { flex-shrink: 0; opacity: .9; }   /* an inline SVG, 11px, currentColor */
```

### Palette

Each row is a *fill* and an *ink*. `--tag-line` is the saturated step of the same hue —
unused by default, kept for outlined variants and for tinting the icon.

| Token | Fill | Ink | Line | Suggested meaning |
|---|---|---|---|---|
| `tag-blue` | `#cfe3fb` | `#1d4fbf` | `#3b82f6` | informational, in progress |
| `tag-lime` | `#e4f59b` | `#4e680d` | `#8fbe1f` | moving the way you want |
| `tag-aqua` | `#b9edd4` | `#14714c` | `#22a96f` | good, complete, healthy |
| `tag-citric` | `#fbdfb0` | `#9a4c08` | `#e2761b` | middling, needs a look |
| `tag-klein` | `#e8d4fa` | `#7028b8` | `#a855f7` | needs a person |
| `tag-fushia` | `#fbd5e8` | `#a61e63` | `#ec4899` | held, blocked |
| `tag-tangerine` | `#fcdad3` | `#a93317` | `#ef5b3c` | stopped, failed, overdue |
| `tag-ink` | `#e6e9ec` | `#46525a` | `#97a3ab` | neutral, archived |

**Dark mode** — deep tint of the hue, light ink:

| Token | Fill | Ink |
|---|---|---|
| `tag-blue` | `#16264a` | `#b9d0f8` |
| `tag-lime` | `#29330f` | `#dcf08a` |
| `tag-aqua` | `#0f3325` | `#9ae9c4` |
| `tag-citric` | `#3a2408` | `#f6cf95` |
| `tag-klein` | `#2b1a45` | `#ddc2fa` |
| `tag-fushia` | `#3b1229` | `#f7bcdb` |
| `tag-tangerine` | `#3d1a12` | `#ffbcae` |
| `tag-ink` | `#1f272c` | `#cfd7dd` |

> **Ink is one step darker than the outline colour, deliberately.** Source references for
> this style usually set the label in the same colour as the border — which works at
> poster size, where 3:1 is a legal ratio. At 12px the threshold is 4.5:1 and that pairing
> measures 2.96:1. Every pair above clears 4.5:1; the tightest is the mint at 4.61.

---

## 5. Other semantic classes

Hues match the tag palette on purpose: **a failure in a sentence and a failure in a badge
should not be two different reds.**

```css
/* Coloured text — validation messages, inline results */
.txt-bad  { color: #a93317; }   /* dark: #ffbcae */
.txt-good { color: #14714c; }   /* dark: #9ae9c4 */
.txt-warn { color: #9a4c08; }   /* dark: #f6cf95 */

/* Inline notice banners */
.notice          { border: 1px solid var(--n-line); background: var(--n-fill);
                   color: var(--n-ink); border-radius: var(--r-sm);
                   padding: 8px 12px; font-size: 12.5px; }
.notice.is-bad    { --n-fill: #fcdad3; --n-line: #f3a695; --n-ink: #a93317; }
.notice.is-warn   { --n-fill: #fbdfb0; --n-line: #e8b878; --n-ink: #9a4c08; }
.notice.is-good   { --n-fill: #b9edd4; --n-line: #7ed4ae; --n-ink: #14714c; }
.notice.is-info   { --n-fill: #cfe3fb; --n-line: #9cc0f5; --n-ink: #1d4fbf; }
.notice.is-violet { --n-fill: #e8d4fa; --n-line: #c49cf3; --n-ink: #7028b8; }

/* Meter and progress fills */
.bar-bad { background: #ef5b3c; }  .bar-good { background: #22a96f; }
.bar-warn{ background: #e2761b; }  .bar-info { background: var(--accent); }
```

---

## 6. Components

### Buttons

```css
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  padding: 7px 14px;
  border: 1px solid var(--rule);
  border-radius: var(--pill);
  background: var(--surface-card);
  color: var(--ink);
  font: 500 12.5px/1 inherit;
  box-shadow: none;
  transition: background .15s, border-color .15s;
}
.btn:hover    { background: var(--surface-sunken); }
.btn:disabled { opacity: .5; cursor: not-allowed; }

.btn-primary        { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover  { background: var(--accent-deep); border-color: var(--accent-deep); }
.btn-danger         { background: #c8412a; border-color: #c8412a; color: #fff; }
.btn-danger:hover   { background: #ad3522; border-color: #ad3522; }
```

> ⚠️ **A trap worth naming.** If your stack is utility-CSS (Tailwind and similar), do
> **not** build variants by composing a base class string with an override for the same
> property — `hover:bg-x` in the base and `hover:bg-y` in the variant. The winner is
> decided by the order the framework emits the rules, not the order they appear in your
> string. This shipped once: on hover the primary button's near-white text landed on a
> light grey ground and the control vanished under the cursor. Define variants as
> component classes.

### Cards

```css
.card {
  background: var(--surface-card);
  border: 1px solid var(--rule);
  border-radius: var(--r);
  box-shadow: none;
}
.card:hover { border-color: var(--rule-strong); }   /* no lift, no shadow */
```

**Flat, on purpose.** With a near-white page and white cards, the surfaces already
separate on tone and the rule draws the edge. A shadow on top is a third statement of the
same boundary. A hover *lift* is worse still — a card that rises with nothing beneath it
to cast onto reads as a rendering glitch.

### Top-bar buttons / tabs

White pill, sitting slightly proud on a soft shadow, quiet grey at rest, accent when
active — **never filled**. A filled tab competes with the primary action, and only one
thing on a screen should win.

```css
.chip {
  padding: 6px 12px; border: 1px solid transparent; border-radius: 10px;
  background: var(--surface-card); color: var(--ink-muted);
  font: 500 12px/1 inherit;
  box-shadow: 0 1px 2px rgba(20,22,29,.06), 0 2px 8px rgba(20,22,29,.05);
}
.chip:hover          { color: var(--ink); box-shadow: 0 2px 4px rgba(20,22,29,.08), 0 6px 16px rgba(20,22,29,.08); }
.chip[aria-pressed="true"], .chip.is-active { color: var(--accent); font-weight: 600; }
```

### Sidebar

Light, narrow (~184px), and **sectioned**. A long undifferentiated list of links is not
navigation — nobody reads to the bottom of it, and adjacent unrelated items tell you
nothing about either.

- Group into **three or four sections** by *what someone is doing when they reach for it*,
  never by how the features were built. Label each section in 9.5px uppercase.
- The **active item is the only coloured thing in the column**: `--accent-wash` ground,
  `--accent` text, 600 weight. That is the job colour should be doing here.
- Resist a solid accent-coloured sidebar. It is a lot of chrome for something people
  navigate past, and it makes every item equally loud — so nothing indicates where you are.

```css
.nav-heading { padding: 0 8px; font: 600 9.5px/1 inherit; letter-spacing: .1em;
               text-transform: uppercase; color: var(--ink-faint); }
.nav-link    { display: flex; align-items: center; justify-content: space-between;
               gap: 6px; padding: 5px 8px; border-radius: 7px;
               font-size: 12.5px; color: var(--ink-muted); }
.nav-link:hover     { background: var(--surface-sunken); color: var(--ink); }
.nav-link.is-active { background: var(--accent-wash); color: var(--accent); font-weight: 600; }
```

### Inputs

```css
.input, .select, .textarea {
  width: 100%; padding: 7px 10px;
  border: 1px solid var(--rule); border-radius: var(--r-sm);
  background: var(--surface-card); color: var(--ink); font-size: 13px;
}
.input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(51,88,232,.18); outline: none; }
```

> Note that these are `width: 100%` by default. If you place several on one row, give them
> explicit widths — otherwise each claims the full row and they stack, which looks like a
> layout bug and is actually a specificity one.

---

## 7. Icons

Inline SVG. One stroke weight, one box, sized from the parent's font-size.

```jsx
<svg width={size} height={size} viewBox="0 0 16 16" fill="none"
     stroke="currentColor" strokeWidth={1.6}
     strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" />
```

- **16-unit viewBox, 1.6 stroke.** Consistency of weight matters more than the drawings.
- **`currentColor` always**, so an icon inherits the colour of whatever it sits in.
- **`aria-hidden` when it accompanies a label**; a real `aria-label` when it stands alone.
- Typical sizes: 11px inside a tag, 13px in a button, 16px as a card mark.

---

## 8. Charts

- **Bars:** cap at ~34px wide. The rule that matters is *a bar must never fill its slot* —
  keep at least a third of each band as air. 4px rounded top, square foot on the baseline.
- **Emphasis:** the series sits back in a desaturated tint (`--viz-bar`) and only the mark
  worth naming takes the accent (`--viz-bar-peak`). Do not saturate the whole series and
  then try to make one bar louder — you have nowhere left to go.
- **Gridlines:** hairline, solid, one step off the surface, behind the data. Never dashed.
- **Axis ticks:** whole numbers, never repeated. Quartering a maximum of 2 yields
  `0,1,1,2,2` — an axis that appears to count the same number twice.
- **Direct labels:** at most one, on the extreme. A number on every point is noise that
  stops being read. Put the rest in a hover readout.
- **Part-to-whole:** a **sequential ramp** (one hue, dark→light) ordered largest to
  smallest, capped at five segments with the tail folded into "Other". Identity lives in
  the legend — name, count and share, as text. Never colour-matching alone.
- **Deltas:** compare like for like. Measuring a part-month against a whole previous month
  makes every figure report a collapse until the month is nearly over.
- **Direction is a glyph, not a colour.** An arrow says up or down; colour only says
  whether that is the direction you wanted — which inverts for metrics where a rise is bad.

---

## 9. Density and layout

| | |
|---|---|
| Page padding | 24px |
| Card padding | 14–16px |
| Grid gap | 12px |
| Section spacing | 16px |
| Table cell padding | 7px vertical |
| Content max width | ~1150px |

The whole scale is one notch tighter than a typical SaaS default. That is intentional for
operational software and would feel cramped on a marketing site.

---

## 10. Checklist before calling it done

- [ ] No hex values in components — everything through tokens
- [ ] Every status badge has a fill, an ink and a glyph
- [ ] Contrast measured: 4.5:1 body, 3:1 large text and UI boundaries
- [ ] Dark mode has its own steps, checked against the dark ground — not an inversion
- [ ] No emoji anywhere in the interface
- [ ] `tabular-nums` on every figure
- [ ] One filled primary action per screen
- [ ] Navigation grouped and sectioned, with a visible active state
- [ ] Charts: bars don't fill their slots, ticks don't repeat, at most one direct label
- [ ] Rendered and *looked at* — a validator checks colour, not layout
