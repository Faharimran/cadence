# enori logotype — reference

**What this is.** Everything needed to place the enori mark correctly in another
product: construction, colour, clear space, minimum sizes, and what not to do. Written
to be handed to a session working on a different codebase.

> ## ⚠️ Read this before anything else
>
> **This is a typographic wordmark, not drawn artwork.** What ships is the word `enori`
> set in Playfair Display with a colour split — it is an approximation of the logotype
> the Brand Guidelines describe, which is a *custom* Didone letterform with a signature
> teardrop terminal on the `r`.
>
> The approximation is deliberate and it holds up at interface sizes. It is **not**
> suitable for print, signage, a favicon at 16px, an app-store icon, or anything where
> the mark is the subject rather than the furniture. For those, get the real vector
> artwork from the brand owner. Do not trace this.

---

## 1. The mark

```
enori
└┬┘└─┬─┘
 │   └── "ori" — the root. Deep ink. Origin, stability, source of truth.
 └────── "en" — the prefix. Accent colour. Enablement, clarity, intelligence.
```

**Indivisible.** `en` and `ori` are one word carrying two colours. They are never
separated, never spaced apart, never stacked.

**Always lowercase.** Never `Enori`. Never `ENORI`. Not at the start of a sentence, not
in a heading that title-cases everything else, not in an all-caps nav. If your CSS
applies `text-transform` anywhere near it, exempt the mark explicitly.

---

## 2. Colour

### As implemented

| Part | Light surface | Dark surface |
|---|---|---|
| `en` prefix | `#3358E8` (brand blue) | `#8FB4FF` |
| `ori` root | `#14161D` (ink) | `#FFFFFF` |

On a dark ground the root switches to **white** and the prefix lightens enough to
survive against it. The prefix never becomes white — losing the two-tone split loses
the mark.

> ### Deviation from the Brand Guidelines, recorded
>
> The Guidelines (p.3) specify the prefix as **Iris Violet `#7266DC`** and the root as
> **Deep Ink Slate `#1B1B2E`**. The implementation uses the product's brand blue instead,
> because the interface palette moved to blue and a violet prefix against an all-blue
> chrome read as an orphan.
>
> **If you are building a product that keeps the violet palette, use `#7266DC`.** The
> structure — accent prefix, ink root — is what matters; the specific accent follows
> whatever the product's accent is.

### One colour only

Where two colours are impossible — single-ink print, embossing, a monochrome context —
set the whole word in the ink colour, or in white on a dark ground. **Never set the
whole word in the accent colour**; a fully-accent wordmark reads as a link.

---

## 3. Clear space

**Exclusion zone on all four sides equal to the height of the lowercase `e`.**

```
┌─────────────────────────────┐
│         ↕ x = e-height      │
│    ┌───────────────────┐    │
│ x  │      enori        │  x │
│    └───────────────────┘    │
│         ↕ x                 │
└─────────────────────────────┘
```

Nothing enters it: no text, no rule, no icon, no card border, no container edge. In a
sidebar or header this is usually satisfied by the block's own padding — check it rather
than assume it, particularly where the mark sits next to a collapse control.

---

## 4. Sizes

| Context | Height |
|---|---|
| Application top navigation | **28px minimum** |
| Compact / narrow sidebar | 22px (what this product ships) |
| Absolute floor, any context | 18px |
| Below 18px | Do not use the wordmark — use the micro mark |

At 22px the teardrop terminal and the vertical contrast that make the letterform
distinctive are already gone. That is acceptable for chrome, where the mark is
identification rather than expression; it is the reason the floor exists.

---

## 5. The micro mark

For favicons, app icons, avatars, collapsed sidebars, and anywhere under 18px.

**The lowercase `e` alone, centred in an accent-coloured squircle.**

| | |
|---|---|
| Container | squircle — rounded square, radius ≈ 30% of side |
| Container fill | `#3358E8` (or the product's accent) |
| Glyph | lowercase `e`, Playfair Display, white |
| Glyph size | ≈ 58% of the container side |
| Optical centring | the `e` sits on the optical centre, not the geometric one — nudge up ~2% |

```html
<span class="enori-mark" aria-label="enori">e</span>
```
```css
.enori-mark {
  display: grid; place-items: center;
  width: 26px; height: 26px;          /* 32px is the comfortable default */
  border-radius: 8px;                  /* ≈30% of the side */
  background: #3358e8;
  color: #ffffff;
  font-family: "Playfair Display", Georgia, serif;
  font-size: 15px; font-weight: 700; line-height: 1;
}
```

As SVG, for a favicon or anywhere text rendering isn't available:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="9.6" fill="#3358E8"/>
  <text x="16" y="22.5" text-anchor="middle"
        font-family="Playfair Display, Georgia, serif"
        font-size="19" font-weight="700" fill="#FFFFFF">e</text>
</svg>
```

> The `<text>` element depends on Playfair Display being available to the renderer, which
> it will not be in most favicon contexts. **Convert the glyph to a path** before shipping
> this anywhere it matters, or ask the brand owner for the drawn asset.

---

## 6. Implementation

```html
<div class="enori-lockup">
  <span class="enori-mark" aria-hidden>e</span>
  <span class="enori-wordmark"><span class="enori-prefix">en</span>ori</span>
</div>
```

```css
.enori-lockup { display: flex; align-items: center; gap: 8px; }

.enori-wordmark {
  font-family: "Playfair Display", Georgia, "Times New Roman", serif;
  font-size: 28px;          /* the 28px navigation minimum */
  line-height: 28px;
  font-weight: 700;
  letter-spacing: -0.01em;  /* Playfair sets loose at display weights */
  color: #14161d;           /* the root */
}
.enori-prefix { color: #3358e8; }

[data-theme="dark"] .enori-wordmark { color: #ffffff; }
[data-theme="dark"] .enori-prefix   { color: #8fb4ff; }
```

**Accessibility.** The lockup is a name, not decoration. Give the link or container an
`aria-label="enori"` and mark the glyph `aria-hidden` — otherwise a screen reader
announces "e enori".

**Loading.** If Playfair Display loads late, the mark reflows from the fallback serif —
visible on a cold load. Preload the single weight you use, and accept Georgia as the
fallback since its proportions are closest.

---

## 7. Misuse

Never:

- **Capitalise it.** `Enori`, `ENORI`, `EnOri` — all wrong.
- **Separate the halves**, or space them apart, or stack them.
- **Recolour the halves to match.** The two-tone split *is* the mark.
- **Set the whole word in the accent.** It reads as a hyperlink.
- **Add effects.** No 3D, no bevel, no outer glow, no drop shadow. Flat vector geometry
  only — the Guidelines are explicit (p.11).
- **Rotate, skew, arch, or condense it.** No stretching to fit a space.
- **Put it on a busy or mid-tone ground.** It needs a light or dark surface that leaves
  both halves legible.
- **Pair it with a tenant's name as a lockup.** Which brings us to —

---

## 8. The mark stands alone

> **Do not place a customer's name beneath the wordmark.**

This is a product sold to organisations that compete with each other. A customer name
sitting under the product mark reads as a lockup — as though the product belongs to that
customer — and the next prospect who sees it is looking at a competitor's branding inside
software they are being asked to buy.

Tenant context belongs in the **account area**, next to the signed-in user, under a
neutral label:

```
CLINIC
Cara Clinic
someone@example.com
```

That reads as *"whose data am I looking at"*, which is what it is for, and cannot be
mistaken for branding. This was caught in review after shipping the other way; it is the
single most expensive mistake available with a white-label mark.

---

## 9. Checklist

- [ ] Lowercase everywhere, with `text-transform` explicitly exempted
- [ ] Two-tone split intact — accent prefix, ink root
- [ ] On dark surfaces: root white, prefix lightened, split preserved
- [ ] Clear space of one `e`-height on all four sides
- [ ] 28px minimum in top navigation; micro mark below 18px
- [ ] No effects — flat, no shadow, no glow, no bevel
- [ ] `aria-label` on the container, `aria-hidden` on the glyph
- [ ] Display face preloaded, sensible serif fallback
- [ ] No customer or tenant name attached to the mark
- [ ] Real vector artwork sourced for print, signage or app icons — **not traced from this**
