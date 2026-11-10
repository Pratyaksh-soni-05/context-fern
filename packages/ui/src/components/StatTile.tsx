import "./StatTile.css";

export interface StatTileProps {
  label: string;
  note: string;
  value: string;
  color: string;
  /** Filled/empty mini-bar beneath the value — real data's own fraction, never decorative filler. */
  filledFraction: number;
}

export function StatTile({
  label,
  note,
  value,
  color,
  filledFraction,
}: StatTileProps) {
  const cellCount = 24;
  const filled = Math.round(
    Math.max(0, Math.min(1, filledFraction)) * cellCount,
  );
  // A fixed-length, never-reordered, purely decorative (aria-hidden)
  // filler bar — position is the only identity these cells have, so an
  // index key is the correct choice here, not a smell.
  const cells = Array.from({ length: cellCount }, (_, i) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: see the comment above Array.from.
      key={i}
      className="stat-tile__cell"
      style={{ background: i < filled ? color : "var(--off)" }}
    />
  ));
  return (
    <div className="stat-tile">
      <span className="stat-tile__row">
        <span className="stat-tile__label">{label}</span>
        <span className="stat-tile__note">{note}</span>
      </span>
      <span className="stat-tile__value" style={{ color }}>
        {value}
      </span>
      <span className="stat-tile__bar" aria-hidden="true">
        {cells}
      </span>
    </div>
  );
}
