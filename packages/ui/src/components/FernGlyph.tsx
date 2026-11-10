// The small stroke-icon fern glyph used on Start and in AppShell's icon
// rail — ported from docs/design/blueprint/Start.dc.html.

export function FernGlyph({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="var(--ink)"
      strokeWidth={1.6}
      strokeLinecap="round"
    >
      <path d="M12 22V3" />
      <path d="M12 7c2-1 4-1 6 0M12 11c-2.5-1.3-5-1.3-7.5 0M12 15c2.2-1.1 4.4-1.1 6.6 0M12 18.5c-1.6-.8-3.2-.8-4.8 0" />
    </svg>
  );
}
