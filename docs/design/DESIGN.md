# Context Fern design spec · v1 (locked 2026-10-23)

Tokens: `tokens.css`. Reference boards (open in a browser to read the markup; they are design references, not production code): `blueprint/`.

| Board | What it defines |
| --- | --- |
| `Main.dc.html` | identity: wordmark, palette, type, pills, buttons, the character-fern specimen |
| `Landing.dc.html` | marketing site (site/) |
| `Start.dc.html` | `fern ui` start screen |
| `Prototype.dc.html` | `fern ui` app, including all interaction behaviour |
| `Install.dc.html`, `ClaudeCode.dc.html` | CLI output, receipts, statusline |
| `SessionCard.dc.html` | `fern export --png` |
| `Architecture.dc.html` | system design |

## Look in one line
Warm paper with an engineering grid, forest-green editorial serif, dot-matrix display words, mono data, ticket cards with notched corners, and the fern drawn as a mosaic of characters with leaflets coloured by frond.

## Rules
1. **Colour carries frond identity only.** Everything else is ink, forest and greys on paper. Frond colours come from the palette in order. Stray is always ember and always dashed. Roots are always ash and dotted. Never rely on colour alone: strays are dashed, roots dotted, merged fronds faded with a "merged" label.
2. **Type roles are fixed.** Doto (900, uppercase) only for display words (BRANCH. FOCUS. UNDO.) and stat numbers. Instrument Serif (400) for headlines and inspector titles, often two-tone: `--text-faint` lead-in, `--forest` or `--ink` payoff. Geist for interface text. Geist Mono for labels, commands, receipts, paths and numbers in tables.
3. **Section header pattern.** Diamond + mono label + dotted rule + optional mono index (001). Use it to open every panel and section.
4. **Cards.** Panels: `--surface` with a 1px `--line` border, square corners. Feature and benchmark cards: tickets (`.ticket`, `--sand`) with an inner dotted field framed by four 12px corner brackets in `--ink`. One ticket per row may be filled `--frond-1` light (`#8DB886`) as the lead.
5. **Buttons.** Primary: `--ink` fill, paper text, 8–12px radius, optional 32–36px moss icon tile on the left. Secondary: white with `--line-control` border and an ink icon tile. Pills: mono 11.5–12px, 999px radius, a 7px colour dot.
6. **Grid.** Paper ground always shows the engineering grid (80px in the app, 96px on the site). Content sits on cards above it, never directly on busy areas.
7. **Motion.** Only for state changes: the fern growing on replay, a frond forking, selection dimming (others to 18% opacity). Under 200 ms, off under `prefers-reduced-motion`.
8. **Accessibility.** Body text ≥ 4.5:1 (`--text-2`, `--text-3` pass on paper; `--text-faint` is for large serif only). Real buttons and inputs; the fern graph also exposes every leaflet through the List view; ARIA tree for the frond legend.
9. **No login screen.** The Start screen replaces it. No account UI anywhere.

## The character fern (brand illustration)
Generated, not drawn. A Barnsley fern iterated with a seeded PRNG (mulberry32) into a character grid; each cell's hit count picks a glyph from the ramp ` .:-+=+*#`. Colour by coarse leaflet: track the trailing run of f2 transforms after the last f3/f4; `(side, level)` → frond colour; `(f4, 0)` → stray ember; everything else `--forest`. Render one absolutely-stacked `<pre>`-style layer per colour so glyphs line up. Reference implementation: `charFern()` / `grow()` in `Main.dc.html` and `Landing.dc.html` (footer meadow = many small ferns into one grid).

## The live fern graph (app)
Reference implementation: `Prototype.dc.html` script. Stem is a quadratic curve; each frond attaches at a fixed point on the stem, alternating sides, length grows with its leaflet count; leaflet nodes are spaced along the frond curve; stippled leaflets are dot paths rendered as `M x y h0` segments with round caps (two opacity buckets). Strays shoot 52px out and 40px down from the leaflet they interrupted, dashed ember, hollow end node. Roots curve from the stem base to memory nodes below, dotted links to the leaflet that used them. In production, drive positions from the store, keep the same visual grammar, and keep the SVG under ~2,000 elements (cap stipple per frond).

## Voice
Plain, short, specific. Receipts start `fern ▸`. Use the vocabulary in spec §4 (frond, leaflet, stray, root, graft, stem) consistently in UI, CLI and docs; never "branch" in user-facing text except in the tagline. Placeholder data in the boards (shop-api, 20 turns, 41k, 62k) is sample data: never ship invented numbers on the site; the benchmark table shows `[result]` until ReplayBench runs.
