// `.fern/fronds/<name>.md` — spec §4's Brief: Goal, Decided, Open, Files,
// Notes, user-editable. A companion `.fern/fronds/.<name>.meta.json`
// tracks the content hash the SYSTEM itself last wrote per section, so a
// later system write can tell "the user never touched this" from "the
// user edited this" and never clobber the latter — merge by section,
// keep the user's text if both changed.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const BRIEF_SECTIONS = [
  "Goal",
  "Decided",
  "Open",
  "Files",
  "Notes",
] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

export type BriefSections = Record<BriefSection, string>;
type SectionHashes = Partial<Record<BriefSection, string>>;

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function metaPathFor(briefPath: string): string {
  const dir = dirname(briefPath);
  const base = briefPath.slice(dir.length + 1);
  return join(dir, `.${base}.meta.json`);
}

function emptySections(): BriefSections {
  return { Goal: "", Decided: "", Open: "", Files: "", Notes: "" };
}

function render(sections: BriefSections): string {
  return BRIEF_SECTIONS.map((s) => `## ${s}\n\n${sections[s]}\n`).join("\n");
}

function parse(markdown: string): BriefSections {
  const sections = emptySections();
  const headingRe = /^## (Goal|Decided|Open|Files|Notes)\s*$/;
  let current: BriefSection | null = null;
  const buffers: Record<BriefSection, string[]> = {
    Goal: [],
    Decided: [],
    Open: [],
    Files: [],
    Notes: [],
  };
  for (const line of markdown.split("\n")) {
    const m = headingRe.exec(line);
    if (m) {
      current = m[1] as BriefSection;
      continue;
    }
    if (current) buffers[current].push(line);
  }
  for (const s of BRIEF_SECTIONS) {
    sections[s] = buffers[s].join("\n").trim();
  }
  return sections;
}

async function readMeta(metaPath: string): Promise<SectionHashes> {
  try {
    return JSON.parse(await readFile(metaPath, "utf-8")) as SectionHashes;
  } catch {
    return {};
  }
}

/** Creates a brief with empty sections and its meta file. */
export async function createBrief(briefPath: string): Promise<void> {
  await mkdir(dirname(briefPath), { recursive: true });
  const sections = emptySections();
  await writeFile(briefPath, render(sections), "utf-8");
  const meta: SectionHashes = {};
  for (const s of BRIEF_SECTIONS) meta[s] = hash(sections[s]);
  await writeFile(metaPathFor(briefPath), JSON.stringify(meta), "utf-8");
}

export async function readBrief(briefPath: string): Promise<BriefSections> {
  return parse(await readFile(briefPath, "utf-8"));
}

export interface WriteBriefResult {
  written: BriefSection[];
  keptUserText: BriefSection[];
}

/**
 * Writes only the given sections, merging by section: a section whose
 * on-disk content still matches the hash the system last wrote is
 * overwritten freely; a section the user has since edited is left alone
 * (the caller's new text for it is discarded) unless the caller's new
 * text is identical to what the system last wrote, in which case there's
 * nothing to do either way.
 */
export async function writeBriefSections(
  briefPath: string,
  updates: Partial<BriefSections>,
): Promise<WriteBriefResult> {
  const current = await readBrief(briefPath);
  const metaPath = metaPathFor(briefPath);
  const meta = await readMeta(metaPath);

  const next: BriefSections = { ...current };
  const written: BriefSection[] = [];
  const keptUserText: BriefSection[] = [];

  for (const [section, newText] of Object.entries(updates) as [
    BriefSection,
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

/** True if every section's current content still matches what the system last wrote (i.e. the user never touched it). */
export async function isBriefUnmodified(briefPath: string): Promise<boolean> {
  const current = await readBrief(briefPath);
  const meta = await readMeta(metaPathFor(briefPath));
  return BRIEF_SECTIONS.every(
    (s) => meta[s] !== undefined && meta[s] === hash(current[s]),
  );
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
