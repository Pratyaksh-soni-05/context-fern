// Caps a brief at ~8KB before it's injected into the model's context (at
// SessionStart, or via /status) — a full brief is for the user; the
// model gets a bounded slice. Recent (machine-generated, regenerated
// every turn anyway) is shrunk first, then Notes (the user's own
// freeform scratch) — Goal/Decided/Open/Files carry the load-bearing
// facts a resumed session actually needs. See docs/decisions.md.

import { quoteSnippetLines } from "@context-fern/core";
import { BRIEF_SECTIONS, type BriefSections } from "@context-fern/store";

/** What the model gets, framing included: ~8KB. */
const TOTAL_MAX_BYTES = 8 * 1024;
/** Room kept for the restore note, header and labels the hook adds around the briefs. */
const FRAMING_RESERVE_BYTES = 1536;
const DEFAULT_MAX_BYTES = TOTAL_MAX_BYTES - FRAMING_RESERVE_BYTES;
const ELLIPSIS = "\n…(truncated)";

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function renderSections(sections: BriefSections): string {
  return (
    BRIEF_SECTIONS.filter((s) => sections[s].trim().length > 0)
      // Quoted, redacted and filtered here, before the byte budget is
      // applied, so the cap is measured on exactly what the model receives.
      .map((s) => `## ${s}\n\n${quoteSnippetLines(sections[s])}`)
      .join("\n\n")
  );
}

/** Truncates `text` so slice+ellipsis together fit within maxBytes. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(text) <= maxBytes) return text;
  const budget = maxBytes - byteLength(ELLIPSIS);
  if (budget <= 0) return "";
  let end = text.length;
  while (end > 0 && byteLength(text.slice(0, end)) > budget) {
    end -= Math.max(1, Math.floor(end * 0.1));
  }
  return `${text.slice(0, end)}${ELLIPSIS}`;
}

/** Shrinks `sections[key]` (re-rendering the whole thing each step, since heading/join overhead varies with content) until the total fits, or it's empty. Returns the fitting candidate text, or null if emptying this section alone wasn't enough. */
function shrinkSection(
  sections: BriefSections,
  key: "Recent" | "Notes",
  maxBytes: number,
): { candidate: string; fits: boolean } {
  let text = sections[key];
  let candidate = renderSections({ ...sections, [key]: text });
  while (byteLength(candidate) > maxBytes && text.length > 0) {
    const shrinkBy = Math.max(1, Math.floor(text.length * 0.1));
    text = text.slice(0, Math.max(0, text.length - shrinkBy));
    const withEllipsis = text.length > 0 ? `${text}${ELLIPSIS}` : "";
    candidate = renderSections({ ...sections, [key]: withEllipsis });
  }
  return { candidate, fits: byteLength(candidate) <= maxBytes };
}

export function truncateBriefForContext(
  sections: BriefSections,
  maxBytes: number = DEFAULT_MAX_BYTES,
): string {
  const full = renderSections(sections);
  if (byteLength(full) <= maxBytes) return full;

  // Recent first — it's machine-generated and gets regenerated every
  // turn anyway, so it's the cheapest thing to lose here.
  const afterRecent = shrinkSection(sections, "Recent", maxBytes);
  if (afterRecent.fits) return afterRecent.candidate;

  // Still over with Recent emptied — shrink Notes (the user's own
  // freeform scratch) next.
  const withoutRecent = { ...sections, Recent: "" };
  const afterNotes = shrinkSection(withoutRecent, "Notes", maxBytes);
  if (afterNotes.fits) return afterNotes.candidate;

  // Still over with both emptied (Goal/Decided/Open/Files alone exceed
  // the budget) — hard-truncate what's left.
  const withoutEither = { ...sections, Recent: "", Notes: "" };
  return truncateToBytes(renderSections(withoutEither), maxBytes);
}

/**
 * The stem's brief and the active frond's brief share one budget (spec §8:
 * the stem is always sent, then the active frond). Each gets half, and a
 * brief that needs less than half hands the rest to the other; within its
 * own share each is shrunk exactly as `truncateBriefForContext` does
 * (Recent first, then Notes). An empty brief renders as "".
 */
export function truncateBriefsForContext(
  stem: BriefSections,
  active: BriefSections,
  maxBytes: number = DEFAULT_MAX_BYTES,
): { stem: string; active: string } {
  const stemFull = byteLength(renderSections(stem));
  const activeFull = byteLength(renderSections(active));
  if (stemFull + activeFull <= maxBytes) {
    return { stem: renderSections(stem), active: renderSections(active) };
  }
  let stemBudget = Math.floor(maxBytes / 2);
  if (stemFull < stemBudget) stemBudget = stemFull;
  let activeBudget = maxBytes - stemBudget;
  if (activeFull < activeBudget) {
    activeBudget = activeFull;
    stemBudget = maxBytes - activeBudget;
  }
  return {
    stem: truncateBriefForContext(stem, stemBudget),
    active: truncateBriefForContext(active, activeBudget),
  };
}
