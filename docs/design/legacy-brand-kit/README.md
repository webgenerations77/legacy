# Handoff: Legacy — Brand & Graphics System

## Overview
**Legacy** is a legacy-planning app with a calm, human, non-legal, non-financial feel (Apple-like simplicity, conversational UI, progressive disclosure). This package documents the brand and graphics system: logo, app icon, color, typography, background textures, iconography for the core screens, empty-state illustrations, and feature spot graphics.

## About the Design Files
The file in this bundle (`Legacy Brand Kit.dc.html`) is a **design reference created in HTML** — a prototype showing the intended look of the brand assets, not production code to copy directly. The HTML is built as a streaming "Design Component" and depends on a runtime (`support.js`); **do not ship it as-is.**

The task is to **recreate these assets in the target codebase's environment** using its established patterns — e.g. ship the logo/icons as real SVG files, the colors as design tokens/CSS variables, the fonts via the app's font pipeline. If no environment exists yet, choose the most appropriate framework and implement there. Everything needed to rebuild the assets without opening the HTML is documented below.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, geometry, and copy. Recreate pixel-accurately. All SVG marks are simple geometric primitives (circles, arcs, lines) and can be reproduced exactly from the specs below.

---

## Design Tokens

### Color
| Token | Hex | Role |
|---|---|---|
| `--paper` | `#FAF8F4` | App background (warmest white) |
| `--cream` | `#F4F1EC` | Secondary surface / canvas |
| `--blue-100` (Mist) | `#E9EEF2` | Subtle blue fill / hover |
| `--blue-200` | `#D4DEE6` | Borders, inactive tracks |
| `--blue-300` (Sky) | `#A9BCC9` | Muted blue accents |
| `--accent` | `#5B7A99` | Primary brand blue — actions, identity |
| `--accent-deep` | `#39495B` | Deep blue — gradients, pressed |
| `--tan` | `#B8A890` | Warm human accent (logo center) |
| `--tan-200` (Sand) | `#E3DACB` | Warm tint surfaces |
| `--ink` | `#33414F` | Primary text |
| `--slate` | `#3A4A5A` | Secondary text / icon stroke |
| `--muted` | `#8492A0` | Tertiary text / mono labels |
| `--alert` | `#B5654F` | Muted terracotta — alerts ONLY, never decoration |

Principle: soft neutrals lead, subtle blue carries actions/identity, warm tan is the single human accent. No harsh reds except the alert token.

### Typography
- **Display / wordmark — Newsreader** (serif), weights 400/500, supports italic. Warm, timeless, trustworthy. Used for the wordmark, headings, and italic captions.
- **Text / UI — Hanken Grotesk** (sans), weights 400/500/600. Calm humanist sans for body and conversational UI.
- **Mono / labels — Spline Sans Mono**, weights 400/500/600. Eyebrow labels, hex values, numeric specs. Used UPPERCASE with `letter-spacing: 0.14em–0.24em`.

Google Fonts import:
```
https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&family=Hanken+Grotesk:wght@400;500;600&family=Spline+Sans+Mono:wght@400;500;600&display=swap
```

### Radius & elevation
- App icon corner radius: **22.4%** of icon size (iOS squircle feel; a rounded-rect at this ratio is acceptable).
- Card radius: `4px`. Color swatches: `6px`.
- Card shadow: `0 1px 2px rgba(40,55,70,.07), 0 14px 38px rgba(40,55,70,.06)`.

---

## The Logo Mark (concentric rings)
Concept: a warm center (a life) with brand-blue rings rippling outward — legacy passing through generations.

**Geometry** (SVG `viewBox="0 0 120 120"`, center 60,60, `fill="none"`):
- Ring 1: `r=52`, stroke `--accent` at opacity `0.22`, stroke-width `2.5`
- Ring 2: `r=39`, stroke `--accent` at opacity `0.5`, stroke-width `2.5`
- Ring 3: `r=26`, stroke `--accent` at opacity `0.85`, stroke-width `2.5`
- Center: filled circle `r=12.5`, fill `--tan`

Stroke-width scales up at small sizes for legibility (≈3 at 48px, ≈4 at 30px). At ~18px and below, collapse to a 2-ring simplified mark: outer ring `r=44` stroke-width 6 at opacity 0.45, center `r=16` fill `--tan`.

**Reversed (on dark):** rings become `#FFFFFF` at opacity `0.26 / 0.55 / 0.92`; center stays `--tan`.

### Wordmark & lockups
- Wordmark: "Legacy" in **Newsreader 500**, `letter-spacing: -0.015em`, color `--ink`.
- **Primary lockup** (horizontal): mark + wordmark, vertically centered, `gap: 30px`. At display scale mark ≈ 96px, wordmark ≈ 64px.
- **Reversed lockup:** same on `--accent-deep` background, wordmark `#FDFCFA`.
- **Stacked:** mark above wordmark (`gap: 18px`), wordmark ~46px, with a mono tagline `PLAN · PROTECT · PASS ON` (`letter-spacing: 0.34em`, `--muted`).
- Clearspace = roughly the radius of ring 3 around the mark on all sides.
- Tagline (italic Newsreader): *"Everything in its place — for the people you love."*

---

## App Icon Variants
Icon = rounded square (22.4% radius) containing the mark scaled to ~65% of the icon, drawn from `viewBox="0 0 120 120"` with rings at `r=50/37/24`.

1. **Full color** — bg `linear-gradient(155deg, var(--accent), var(--accent-deep))`; rings white at opacity `0.28/0.58/0.95`; center `--tan`. Shadow `0 12px 26px rgba(57,73,91,.28)`.
2. **Dark** — bg `linear-gradient(155deg,#2C3947,#1D2630)`; rings `--accent` opacity `0.35/0.65` + inner ring `--blue-300`; center `--tan`.
3. **Monochrome** — bg `--ink`; rings + center all white (opacity `0.3/0.6/0.92/1`).
4. **Light tint** — bg `linear-gradient(155deg,#FFF,var(--blue-100))`, `1px` border `--blue-200`; rings `--accent` opacity `0.25/0.55/0.9`; center `--tan`.

---

## Background Textures (calm, low-contrast)
1. **Ripple** — `repeating-radial-gradient(circle at 50% 36%, rgba(91,122,153,.12) 0 1.5px, transparent 1.5px 17px), var(--paper)`. Use: feed, empty states.
2. **Soft mesh** — three `radial-gradient`s over `--cream`: blue `rgba(91,122,153,.20)` at 18%/20%, tan `rgba(184,168,144,.24)` at 82%/26%, sky `rgba(169,188,201,.26)` at 50%/92% (each `transparent 55–58%`). Use: onboarding.
3. **Calm wash** — `linear-gradient(160deg, var(--paper), var(--blue-100))`. Use: default screens.
4. **Contour** — `repeating-radial-gradient(circle at 72% 118%, transparent 0 22px, rgba(58,74,90,.07) 22px 23px), var(--cream)`. Use: vault, score.
5. **Brand wash** — `linear-gradient(150deg, var(--accent), var(--accent-deep))`. Use: headers, hero.
6. **Warm** — `linear-gradient(160deg, var(--tan-200), var(--paper))`. Use: family, gentle moments.

---

## Iconography (core screens)
Line icons, `viewBox="0 0 48 48"`, stroke `--slate`, **stroke-width 1.75**, round caps/joins. Exact paths are in the HTML; summary:
- **Home Feed** — rounded speech bubble with tail + two text lines.
- **Completion Score** — progress ring: faint `--blue-200` track + `--accent` arc (~75%) + `--tan` center dot `r=4`.
- **Vault** — shield outline + small keyhole (circle `r=3.5` + stem).
- **Family Access** — three connected nodes (one head circle `r=5` top, two `r=4.5` bottom) linked by lines.
- **Survivor Mode** — compass: circle `r=16` + a filled `--tan` four-point star/needle.

---

## Empty-State Illustrations (line, geometric)
1. **Generations** — large concentric rings (`r=60/42/24`, `--accent` low opacity) with a `--tan` center and small member dots placed on the rings. Caption: *"Everyone you carry forward."*
2. **Safe harbor** — simple house outline (`--slate`) inside a soft blue circle. Caption: *"A home for what matters."*
3. **Guiding light** — an opening door with a warm `--tan` sun/rays. Caption: *"A door, gently opened."*

---

## Feature Spot Graphics
Five 236×300 cards, gradient bg, white line icon top-left, **Newsreader 26px** title + **Hanken Grotesk 13.5px** descriptor (`rgba(255,255,255,.8)`):
- **Home Feed** — `linear-gradient(160deg,#5B7A99,#39495B)` — "A calm daily check-in, one gentle step at a time."
- **Completion Score** — `linear-gradient(160deg,#4F6C87,#2F3D4C)` — "See what's done — without any pressure."
- **Vault** — `linear-gradient(160deg,#3C4D5F,#222D39)` — "Documents and wishes, kept safe and private."
- **Family Access** — `linear-gradient(160deg,#B8A890,#8E7C63)` — "Share the right things, when the time is right."
- **Survivor Mode** — `linear-gradient(160deg,#5B7A99,#42566A)` — "Steady guidance for those left behind."

---

## Interactions & Behavior
The brand kit itself is a static reference (no interactive flows). For the app, follow the system tone in copy: supportive, calm, non-alarming. Reserve the `--alert` terracotta for genuine alerts only; everything else stays neutral/blue.

## Assets to produce in-codebase
- Export the mark as standalone SVG (full-color, reversed, monochrome).
- App icon set at platform sizes (the 22.4% squircle on iOS).
- Core-screen icons as an SVG icon set.
- Empty-state illustrations as SVG.
- Background textures as CSS gradients (above) or pre-rendered assets.
- Fonts: Newsreader, Hanken Grotesk, Spline Sans Mono via the app's font pipeline.

## Files
- `Legacy Brand Kit.dc.html` — the full visual reference (open in a browser to view; all geometry/colors/copy are documented above).
- `support.js` — runtime required only to render the HTML reference; not part of the deliverable.
