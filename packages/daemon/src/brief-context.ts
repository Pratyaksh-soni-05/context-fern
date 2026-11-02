// Caps a brief at ~8KB before it's injected into the model's context (at
// SessionStart, or via /status) — a full brief is for the user; the
// model gets a bounded slice. Notes (freeform scratch) is truncated
// first, since Goal/Decided/Open/Files carry the load-bearing facts a
// resumed session actually needs — see docs/decisions.md.

import { BRIEF_SECTIONS, type BriefSections } from "@context-fern/store";

const DEFAULT_MAX_BYTES = 8 * 1024;
const ELLIPSIS = "\n…(truncated)";

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function renderSections(sections: BriefSections): string {
  return BRIEF_SECTIONS.filter((s) => sections[s].trim().length > 0)
    .map((s) => `## ${s}\n\n${sections[s]}`)
    .join("\n\n");
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

export function truncateBriefForContext(
  sections: BriefSections,
  maxBytes: number = DEFAULT_MAX_BYTES,
): string {
  const full = renderSections(sections);
  if (byteLength(full) <= maxBytes) return full;

  // Shrink Notes first, measuring the real rendered total each step (the
  // "## Notes" heading and section-join overhead vary with content, so
  // this re-renders rather than pre-computing a byte budget).
  let notesText = sections.Notes;
  let candidate = renderSections({ ...sections, Notes: notesText });
  while (byteLength(candidate) > maxBytes && notesText.length > 0) {
    const shrinkBy = Math.max(1, Math.floor(notesText.length * 0.1));
    notesText = notesText.slice(0, Math.max(0, notesText.length - shrinkBy));
    const withEllipsis = notesText.length > 0 ? `${notesText}${ELLIPSIS}` : "";
    candidate = renderSections({ ...sections, Notes: withEllipsis });
  }
  if (byteLength(candidate) <= maxBytes) return candidate;

  // Still over cap with Notes emptied (Goal/Decided/Open/Files alone
  // exceed the budget) — hard-truncate what's left.
  const withoutNotes = renderSections({ ...sections, Notes: "" });
  return truncateToBytes(withoutNotes, maxBytes);
}
