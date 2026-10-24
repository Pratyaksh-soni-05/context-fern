// Public types. Changing these needs an entry in docs/decisions.md (see CLAUDE.md).
// Vocabulary: docs/spec.md §4.

export type Mode = "observe" | "suggest" | "isolate";

export type FrondStatus = "active" | "resting" | "merged";

/** What the router outputs for one leaflet. Spec §5. */
export type RouterAction = "continue" | "new" | "return" | "combine" | "stray";

/**
 * Everything a Decision can record in the journal. A graft is a merge back
 * to the stem (action "merge") or a combine that used two fronds (action
 * "combine", see `Decision.with`) — neither is a separate stored entity.
 * Undo is not its own action: it's the `Decision.undone` flag plus the
 * action's registered inverse.
 */
export type DecisionAction = RouterAction | "merge";

/** One agent conversation in one project directory. Spec §4. */
export interface Session {
  id: string;
  agent: string;
  projectPath: string;
  startedAt: string;
  mode: Mode;
}

/**
 * A topic thread: name, colour index, status, centroid vector and brief.
 * Spec §4. A stem is not a separate stored entity — it's a Frond with
 * `parentId: null`. A brief is not a separate stored entity either — it's
 * the markdown file at `briefPath`.
 */
export interface Frond {
  id: string;
  sessionId: string;
  parentId: string | null;
  name: string;
  colorIndex: number;
  status: FrondStatus;
  centroid: number[] | null;
  briefPath: string;
  createdAt: string;
}

export interface FileTouch {
  path: string;
  source: "tool_input" | "command";
}

/**
 * One exchange (a human prompt plus everything until the next prompt),
 * placed on a frond. Spec §4. `frondId` is null for a stray: answered, then
 * kept off every frond and out of future context. `strayFrom` is only set
 * on a stray — the frond (or stem) it interrupted, so the UI can draw it
 * shooting off that frond. Content is never stored, only a hash and counts.
 */
export interface Leaflet {
  id: string;
  sessionId: string;
  index: number;
  frondId: string | null;
  strayFrom: string | null;
  promptHash: string;
  tokenCount: number;
  filesTouched: FileTouch[];
  createdAt: string;
}

/**
 * A memory from an earlier session that feeds a frond: read-only in v1,
 * imported from CLAUDE.md, MEMORY.md or memory tools. Spec §4, §12. Roots
 * belong to a project, not a session — they can feed any session opened in
 * that project. Which leaflet used a root is recorded on the Decision that
 * routed it, via `rootsUsed`, not on the Root itself.
 */
export interface Root {
  id: string;
  projectPath: string;
  source: "CLAUDE.md" | "MEMORY.md" | "memory-tool";
  label: string;
  contentHash: string;
  createdAt: string;
}

/** One routing decision recorded in the journal with its inverse. Spec §4, §5, §11. */
export interface Decision {
  id: string;
  leafletId: string;
  action: DecisionAction;
  target: string | null;
  /** The second frond, for a combine. */
  with?: string;
  /** Which router stage produced this decision: 0 (local) or 2 (LLM escalation). */
  stage: 0 | 2;
  /** Root ids this decision drew into the leaflet's context, if any. */
  rootsUsed?: string[];
  signals: string[];
  confidence: number;
  tokensBefore: number;
  tokensAfter: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  undone: boolean;
  createdAt: string;
}
