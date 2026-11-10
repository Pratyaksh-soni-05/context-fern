// The static brand illustration (not the live, data-driven graph in
// FernView) — see src/design/fern-art.ts for the generator. Purely
// decorative: aria-hidden, no interaction, nothing to announce.

import { fern } from "../design/fern-art";

const ART = fern(16000, 21);

export function CharacterFern() {
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 620 660"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <path
        d={ART.d1}
        fill="none"
        stroke="var(--forest)"
        strokeWidth={2.6}
        strokeLinecap="square"
        opacity={0.35}
      />
      <path
        d={ART.d2}
        fill="none"
        stroke="var(--forest)"
        strokeWidth={2.6}
        strokeLinecap="square"
        opacity={0.7}
      />
      <path
        d={ART.d3}
        fill="none"
        stroke="var(--forest)"
        strokeWidth={2.8}
        strokeLinecap="square"
        opacity={1}
      />
    </svg>
  );
}
