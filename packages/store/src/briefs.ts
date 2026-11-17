// `.fern/fronds/<name>.md` — spec §4's Brief: Goal, Decided, Open, Files,
// Notes, Recent. A companion `.fern/fronds/.<name>.meta.json` tracks the
// content hash the SYSTEM itself last wrote per section, so a later
// system write can tell "the user never touched this" from "the user
// edited this" and never clobber the latter — merge by section, keep
// the user's text if both changed. Recent is the one exception: it's
// machine-owned (the last 5 prompts, newest first), always rewritten in
// full via `pushRecentEntry`, and never goes through that merge at all —
// see its own doc comment below.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const BRIEF_SECTIONS = [
  "Goal",
  "Decided",
  "Open",
  "Files",
  "Notes",
  "Recent",
] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

/** Every section writeBriefSections' user-edit-preserving merge applies to — i.e. every section except the machine-owned Recent. */
export type MergeableBriefSection = Exclude<BriefSection, "Recent">;

export type BriefSections = Record<BriefSection, string>;
type SectionHashes = Partial<Record<MergeableBriefSection, string>>;

const RECENT_NOTE =
  "<!-- fern maintains this section automatically; edits here are not kept -->";
const RECENT_MAX = 5;

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function metaPathFor(briefPath: string): string {
  const dir = dirname(briefPath);
  const base = briefPath.slice(dir.length + 1);
  return join(dir, `.${base}.meta.json`);
}

function emptySections(): BriefSections {
  return { Goal: "", Decided: "", Open: "", Files: "", Notes: "", Recent: "" };
}

function render(sections: BriefSections): string {
  return BRIEF_SECTIONS.map((s) => {
    const body =
      s === "Recent"
        ? [RECENT_NOTE, sections[s]].filter(Boolean).join("\n")
        : sections[s];
    return `## ${s}\n\n${body}\n`;
  }).join("\n");
}

function parse(markdown: string): BriefSections {
  const sections = emptySections();
  const headingRe = /^## (Goal|Decided|Open|Files|Notes|Recent)\s*$/;
  let current: BriefSection | null = null;
  const buffers: Record<BriefSection, string[]> = {
    Goal: [],
    Decided: [],
    Open: [],
    Files: [],
    Notes: [],
    Recent: [],
  };
  for (const line of markdown.split("\n")) {
    const m = headingRe.exec(line);
    if (m) {
      current = m[1] as BriefSection;
      continue;
    }
    // RECENT_NOTE is a rendering artifact (added by render(), below),
    // never part of Recent's actual content — strip it back out here so
    // readBrief() returns just the real entries.
    if (current === "Recent" && line === RECENT_NOTE) continue;
    if (current) buffers[current].push(line);
  }
  for (const s of BRIEF_SECTIONS) {
    sections[s] = buffers[s].join("\n").trim();
  }
  return sections;
}

export interface RecentEntry {
  /** The leaflet turn number this entry was written for, or null for a line with no machine-written tag (a hand-typed Recent line, or an entry written before this tag format existed). */
  turn: number | null;
  text: string;
  /** First line of the assistant's reply to this prompt, already redacted and capped (core's `sanitizeReplyGist`). Written on the line under the prompt as `  ↳ reply: <gist>`. Absent when none was recorded. */
  reply?: string;
}

const RECENT_ENTRY_RE = /^- t(\d+) · (.*)$/;
const RECENT_REPLY_RE = /^↳ reply: (.*)$/;

/** Recent's on-disk entries, one per `- ` bullet (plus the `↳ reply:` line under it, if any), with the machine note stripped and the `tN · ` turn tag (if present) parsed back out — the inverse of what pushRecentEntry writes. Exported so a caller (the daemon's /leaflets handler) can map a leaflet's turn number back to real prompt text without duplicating this parsing. */
export function parseRecentEntries(raw: string): RecentEntry[] {
  const entries: RecentEntry[] = [];
  for (const l of raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== RECENT_NOTE)) {
    const reply = RECENT_REPLY_RE.exec(l);
    const previous = entries[entries.length - 1];
    if (reply && previous) {
      previous.reply = reply[1] ?? "";
      continue;
    }
    const m = RECENT_ENTRY_RE.exec(l);
    if (m) entries.push({ turn: Number(m[1]), text: m[2] ?? "" });
    else
      entries.push({ turn: null, text: l.startsWith("- ") ? l.slice(2) : l });
  }
  return entries;
}

function renderRecentEntry(e: RecentEntry): string {
  const line = e.turn !== null ? `- t${e.turn} · ${e.text}` : `- ${e.text}`;
  return e.reply ? `${line}\n  ↳ reply: ${e.reply}` : line;
}

async function readMeta(metaPath: string): Promise<SectionHashes> {
  try {
    return JSON.parse(await readFile(metaPath, "utf-8")) as SectionHashes;
  } catch {
    return {};
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a brief with empty sections and its meta file — a no-op if a
 * brief already exists at this path. Dogfooding traced an empty brief
 * after real content had already accumulated back to exactly this: the
 * caller (`createFrond`) has no duplicate-name guard of its own, so a
 * second `/fern new <existing-name>` (fixed separately — see
 * docs/decisions.md) called this unconditionally and wiped real
 * content back to blank templates. Guarding here too, rather than
 * trusting every caller to check first, since a frond name becomes a
 * real, name-derived file path (`.fern/fronds/<name>.md`) shared by
 * anything that creates a frond with that name.
 */
export async function createBrief(briefPath: string): Promise<void> {
  if (await fileExists(briefPath)) return;
  await mkdir(dirname(briefPath), { recursive: true });
  const sections = emptySections();
  await writeFile(briefPath, render(sections), "utf-8");
  const meta: SectionHashes = {};
  for (const s of BRIEF_SECTIONS) {
    if (s === "Recent") continue;
    meta[s] = hash(sections[s]);
  }
  await writeFile(metaPathFor(briefPath), JSON.stringify(meta), "utf-8");
}

export async function readBrief(briefPath: string): Promise<BriefSections> {
  return parse(await readFile(briefPath, "utf-8"));
}

export interface WriteBriefResult {
  written: MergeableBriefSection[];
  keptUserText: MergeableBriefSection[];
}

/**
 * Writes only the given sections, merging by section: a section whose
 * on-disk content still matches the hash the system last wrote is
 * overwritten freely; a section the user has since edited is left alone
 * (the caller's new text for it is discarded) unless the caller's new
 * text is identical to what the system last wrote, in which case there's
 * nothing to do either way. Recent is excluded from this entirely — it's
 * machine-owned; use `pushRecentEntry` for it instead.
 */
export async function writeBriefSections(
  briefPath: string,
  updates: Partial<Record<MergeableBriefSection, string>>,
): Promise<WriteBriefResult> {
  const current = await readBrief(briefPath);
  const metaPath = metaPathFor(briefPath);
  const meta = await readMeta(metaPath);

  const next: BriefSections = { ...current };
  const written: MergeableBriefSection[] = [];
  const keptUserText: MergeableBriefSection[] = [];

  for (const [section, newText] of Object.entries(updates) as [
    MergeableBriefSection,
    string,
  ][]) {
    const lastSystemHash = meta[section];
    const currentHash = hash(current[section]);
    const userEdited =
      lastSystemHash !== undefined && lastSystemHash !== currentHash;
    const sameAsLastWrite = hash(newText) === lastSystemHash;

    if (userEdited && !sameAsLastWrite) {
      keptUserText.push(section);
      continue;
    }
    next[section] = newText;
    meta[section] = hash(newText);
    written.push(section);
  }

  await writeFile(briefPath, render(next), "utf-8");
  await writeFile(metaPath, JSON.stringify(meta), "utf-8");
  return { written, keptUserText };
}

/**
 * Prepends one entry to Recent's rolling window (newest first, capped
 * at `RECENT_MAX`), tagged with the leaflet `turn` number that produced
 * it (rendered as `- t<turn> · <entry>`). The tag, not the entry's
 * position in the window, is what a reader (the daemon's /leaflets
 * handler) uses to map a specific leaflet back to its real prompt text —
 * a consecutive duplicate collapses (see below) without ever being
 * written, so "the Nth-from-top entry" and "the Nth-most-recent leaflet"
 * are not reliably the same thing. See docs/decisions.md.
 *
 * No meta/hash check, no merge — unlike every other section, a user's
 * hand-edit to Recent gets no special preservation: there's no second
 * source of truth to restore it from (prompt text lives only in the
 * brief file, never fern.db), so whatever is on disk when this runs —
 * system-written or hand-typed — is simply treated as the current
 * rolling window and carried forward until it rolls off. A hand-typed
 * line (no `tN · ` tag) round-trips untagged.
 *
 * `reply`, when given, is the gist of the assistant's answer to this
 * prompt (core's `sanitizeReplyGist` output), kept on the line under it.
 * Recent lists prompts and, where recorded, a one-line gist of each
 * reply — never outcomes, and never file contents.
 *
 * No-op if `entry` is empty (e.g. a frond created by a direct
 * `/fern new <name>` with no triggering prompt text yet), or if its text
 * is identical to the current newest entry's text (a retried/double-
 * submitted prompt shouldn't fill the window with repeats of the same
 * line) — in that case the newest entry's turn tag is left as-is, not
 * updated to the new call's turn.
 */
export async function pushRecentEntry(
  briefPath: string,
  turn: number,
  entry: string,
  reply?: string | null,
): Promise<void> {
  if (!entry) return;
  const current = await readBrief(briefPath);
  const existing = parseRecentEntries(current.Recent);
  if (existing[0]?.text === entry) {
    // A retried prompt keeps its entry and turn tag, but a reply gist the
    // first attempt never got is still worth keeping.
    if (reply && !existing[0].reply) {
      const filled = [{ ...existing[0], reply }, ...existing.slice(1)];
      await writeFile(
        briefPath,
        render({
          ...current,
          Recent: filled.map(renderRecentEntry).join("\n"),
        }),
        "utf-8",
      );
    }
    return;
  }
  const nextEntries: RecentEntry[] = [
    { turn, text: entry, ...(reply ? { reply } : {}) },
    ...existing,
  ].slice(0, RECENT_MAX);
  const next: BriefSections = {
    ...current,
    Recent: nextEntries.map(renderRecentEntry).join("\n"),
  };
  await writeFile(briefPath, render(next), "utf-8");
}

/** True if every mergeable section's current content still matches what the system last wrote (i.e. the user never touched it). Recent is excluded — it's machine-owned and rewritten on its own schedule, so its activity alone must never count as "the user touched this brief." */
export async function isBriefUnmodified(briefPath: string): Promise<boolean> {
  const current = await readBrief(briefPath);
  const meta = await readMeta(metaPathFor(briefPath));
  return BRIEF_SECTIONS.filter(
    (s): s is MergeableBriefSection => s !== "Recent",
  ).every((s) => meta[s] !== undefined && meta[s] === hash(current[s]));
}

/**
 * Resolves a brief that `undoLast` is deleting the owning frond for:
 * if it was never touched, delete it (and its meta file); otherwise move
 * both into `.fern/fronds/.undone/` so the user's text is never lost.
 */
export async function archiveOrDeleteBrief(
  briefPath: string,
  frondName: string,
  decisionId: string,
): Promise<void> {
  const metaPath = metaPathFor(briefPath);
  if (await isBriefUnmodified(briefPath)) {
    await rm(briefPath, { force: true });
    await rm(metaPath, { force: true });
    return;
  }
  const undoneDir = join(dirname(briefPath), ".undone");
  await mkdir(undoneDir, { recursive: true });
  await rename(briefPath, join(undoneDir, `${frondName}-${decisionId}.md`));
  await rename(
    metaPath,
    join(undoneDir, `.${frondName}-${decisionId}.md.meta.json`),
  );
}

function mergeMarkerStart(decisionId: string): string {
  return `<!-- fern:merge:${decisionId} -->`;
}
function mergeMarkerEnd(decisionId: string): string {
  return `<!-- /fern:merge:${decisionId} -->`;
}

async function writeDecidedDirect(
  briefPath: string,
  nextDecided: string,
): Promise<void> {
  const current = await readBrief(briefPath);
  const next = { ...current, Decided: nextDecided };
  await writeFile(briefPath, render(next), "utf-8");
  const metaPath = metaPathFor(briefPath);
  const meta = await readMeta(metaPath);
  meta.Decided = hash(nextDecided);
  await writeFile(metaPath, JSON.stringify(meta), "utf-8");
}

/**
 * Appends `text` to the stem brief's Decided section, wrapped in a
 * marker keyed to `decisionId` — not a positional tail-match, so a
 * second merge (or a user hand-editing the brief afterward) can't make
 * undo strip the wrong text. Writes directly (bypassing
 * `writeBriefSections`' conflict logic): merge is an explicit user
 * command, not a background rewrite, so it must never be silently
 * dropped just because the user had edited Decided earlier.
 */
export async function appendMergeBlock(
  stemBriefPath: string,
  decisionId: string,
  text: string,
): Promise<void> {
  const current = await readBrief(stemBriefPath);
  const block = `${mergeMarkerStart(decisionId)}\n${text}\n${mergeMarkerEnd(decisionId)}`;
  const nextDecided = current.Decided
    ? `${current.Decided}\n\n${block}`
    : block;
  await writeDecidedDirect(stemBriefPath, nextDecided);
}

/**
 * Strips exactly the block marked with `decisionId` back out of the stem
 * brief's Decided section. Returns false (does nothing) if the marker
 * isn't found — e.g. the brief was hand-edited since — so the caller can
 * fail loud instead of silently doing nothing or stripping the wrong span.
 */
export async function stripMergeBlock(
  stemBriefPath: string,
  decisionId: string,
): Promise<boolean> {
  const current = await readBrief(stemBriefPath);
  const start = mergeMarkerStart(decisionId);
  const end = mergeMarkerEnd(decisionId);
  const startIdx = current.Decided.indexOf(start);
  const endIdx = current.Decided.indexOf(end);
  if (startIdx === -1 || endIdx === -1) return false;

  const before = current.Decided.slice(0, startIdx).replace(/\n+$/, "");
  const after = current.Decided.slice(endIdx + end.length).replace(/^\n+/, "");
  const nextDecided = [before, after].filter(Boolean).join("\n\n");
  await writeDecidedDirect(stemBriefPath, nextDecided);
  return true;
}
