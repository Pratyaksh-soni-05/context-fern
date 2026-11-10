// spec §11: "Frond colours are assigned in order from the palette in
// tokens.css (moss, lake, iris, ochre, rose, then repeat with a
// pattern); stray is always ember, roots always ash." The daemon
// assigns `colorIndex` in creation order (see fern-store.ts's
// nextColorIndex); this just maps that index onto the 5-colour token
// palette, repeating via modulo once a session has more than 5 fronds.

const PALETTE_SIZE = 5;

export function frondColorVar(colorIndex: number): string {
  const n = ((colorIndex % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
  return `var(--frond-${n + 1})`;
}

export function frondInkVar(colorIndex: number): string {
  const n = ((colorIndex % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
  return `var(--frond-${n + 1}-ink)`;
}

export const STEM_COLOR_VAR = "var(--stem)";
export const STRAY_COLOR_VAR = "var(--stray)";
export const STRAY_INK_VAR = "var(--stray-ink)";
export const ROOT_COLOR_VAR = "var(--root)";
