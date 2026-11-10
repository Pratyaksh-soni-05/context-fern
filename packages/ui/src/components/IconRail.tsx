// The left icon rail — ported from Prototype.dc.html. Journal/Terminal/
// Settings are decorative stubs in the reference board too (no handler
// there either); kept as plain disabled-looking buttons rather than
// wired to nothing, so they don't read as broken interactive controls.

import { FernGlyph } from "./FernGlyph";
import "./IconRail.css";

export type View = "fern" | "list" | "categories";

export interface IconRailProps {
  view: View;
  onChangeView: (view: View) => void;
}

function RailIcon({ d }: { d: string }) {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 18 18"
      aria-hidden="true"
      fill="none"
      stroke="var(--ink)"
      strokeWidth={1.4}
      strokeLinecap="round"
    >
      <path d={d} />
    </svg>
  );
}

export function IconRail({ view, onChangeView }: IconRailProps) {
  return (
    <nav aria-label="App" className="icon-rail">
      <FernGlyph size={24} />
      <div className="icon-rail__gap" />
      <button
        type="button"
        aria-label="Fern view"
        aria-pressed={view === "fern"}
        className="icon-rail__button"
        data-active={view === "fern"}
        onClick={() => onChangeView("fern")}
      >
        <RailIcon d="M9 16V2M9 6l4-2M9 9 4.5 6.5M9 12l4.5-2.5" />
      </button>
      <button
        type="button"
        aria-label="List view"
        aria-pressed={view === "list"}
        className="icon-rail__button"
        data-active={view === "list"}
        onClick={() => onChangeView("list")}
      >
        <RailIcon d="M6 4.5h9M6 9h9M6 13.5h9M3 4.5h.01M3 9h.01M3 13.5h.01" />
      </button>
      <button
        type="button"
        aria-label="Categories view"
        aria-pressed={view === "categories"}
        className="icon-rail__button"
        data-active={view === "categories"}
        onClick={() => onChangeView("categories")}
      >
        <svg
          width={18}
          height={18}
          viewBox="0 0 18 18"
          aria-hidden="true"
          fill="none"
          stroke="var(--ink)"
          strokeWidth={1.4}
        >
          <rect x={2.5} y={2.5} width={5.5} height={5.5} rx={1} />
          <rect x={10} y={2.5} width={5.5} height={5.5} rx={1} />
          <rect x={2.5} y={10} width={5.5} height={5.5} rx={1} />
          <rect x={10} y={10} width={5.5} height={5.5} rx={1} />
        </svg>
      </button>
      <div className="icon-rail__divider" />
      <button
        type="button"
        aria-label="Journal (coming soon)"
        title="Coming soon"
        className="icon-rail__button icon-rail__button--stub"
        disabled
      >
        <RailIcon d="M4 3h8l2 2v10H4z" />
      </button>
      <button
        type="button"
        aria-label="Terminal (coming soon)"
        title="Coming soon"
        className="icon-rail__button icon-rail__button--stub"
        disabled
      >
        <RailIcon d="m4 5 4 4-4 4M10 13h4" />
      </button>
      <div className="icon-rail__spacer" />
      <button
        type="button"
        aria-label="Settings (coming soon)"
        title="Coming soon"
        className="icon-rail__button icon-rail__button--stub"
        disabled
      >
        <svg
          width={18}
          height={18}
          viewBox="0 0 18 18"
          aria-hidden="true"
          fill="none"
          stroke="var(--text-3)"
          strokeWidth={1.4}
        >
          <circle cx={9} cy={9} r={2.2} />
          <path d="M9 2v2M9 14v2M2 9h2M14 9h2M4 4l1.4 1.4M12.6 12.6 14 14M4 14l1.4-1.4M12.6 5.4 14 4" />
        </svg>
      </button>
    </nav>
  );
}
