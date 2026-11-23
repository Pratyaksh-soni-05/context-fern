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

/**
 * Produces embedding vectors for text. Implemented in packages/embed;
 * declared here (not there) so router code can depend on the shape
 * without core ever depending on embed. Dependencies point inward:
 * embed imports this type from core, never the reverse.
 */
export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * One text-completion call to a (local, in this PR) LLM. Implemented in
 * packages/daemon (Ollama); declared here so router code can depend on
 * the shape without core ever depending on daemon. A paid provider could
 * implement this interface later — none exists yet.
 */
export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  complete(params: { prompt: string; model: string }): Promise<LlmResponse>;
}

/**
 * Journal record for one Stage 2 LLM call: model/tokens/latency, per
 * CLAUDE.md's "every LLM call is journaled, no hidden calls" rule. This
 * is deliberately narrower than `Decision` — it's scoped to "an LLM call
 * happened," not the full router-decision journal (Decision.tokensBefore/
 * After are isolate-mode context-payload tokens, a different concept).
 */
export interface Stage2CallLog {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  escalatedAction: RouterAction;
  escalatedConfidence: number;
  succeeded: boolean;
  createdAt: string;
}

/**
 * Journal record for one mode change (`fern mode`, `/fern mode`, the UI's
 * mode pill): a mode decides what the model is shown, so changing it is
 * journaled like any action that changes what the model sees (CLAUDE.md's
 * accountability rule). It carries the mode before and after and the active
 * frond, never any prompt text. It is not a routing `Decision`: there is no
 * leaflet, no router signal and no token count behind it, so those fields
 * are explicit nulls and `fern undo` never reverses it; its inverse is
 * `fern mode <before>`, which is itself journaled. See docs/decisions.md,
 * 2026-11-20 (mode changes are journaled).
 */
export interface ModeChangeLog {
  id: string;
  sessionId: string;
  action: "mode";
  /** The active frond when the mode changed; null only if the session has none. */
  frondId: string | null;
  /** A mode change is not a turn. */
  leafletId: null;
  before: Mode;
  after: Mode;
  /** A direct command, never the router. */
  stage: "manual";
  signals: string[];
  confidence: 1;
  /** Unknown: the effect on what the model sees shows on the next turn. */
  tokensBefore: null;
  tokensAfter: null;
  cacheReadTokens: null;
  cacheWriteTokens: null;
  createdAt: string;
}

/**
 * Everything `.fern/journal.jsonl` can carry: a Stage 2 LLM call, a full
 * routing `Decision`, or a mode change. See docs/decisions.md, 2026-10-26
 * (closing the "Decision journaling/undo stays out of scope" gap from
 * 2026-10-25) and 2026-11-20 (mode changes).
 */
export type JournalEntry = Stage2CallLog | Decision | ModeChangeLog;

/** Implemented in packages/store. Declared here for the same inward-dependency reason as Embedder/LlmClient. */
export interface JournalSink {
  record(entry: JournalEntry): void | Promise<void>;
}

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

/**
 * What undoing a `Decision` restores. `"router"` covers continue/new/
 * return/combine/stray uniformly (see `buildDecisionInverse` in
 * packages/core/src/router/decision.ts) — only `activeFrondId` and each
 * frond's `status` are captured, never centroid/count/files drift, so a
 * `continue` is a true no-op and undoing `new`/`return`/`combine` restores
 * the frond tree's topology, not the exact routing signals a later turn
 * would recompute. `"merge"` is separate because it isn't router-triggered
 * (no leaflet, no RouterState) and restores a frond's status plus the
 * stem brief's appended block (located by `decisionId` marker, not by
 * position — see docs/decisions.md, 2026-10-26).
 */
export type DecisionInverse =
  | {
      kind: "router";
      priorActiveFrondId: string | null;
      priorFrondStatuses: Record<string, FrondStatus>;
      createdFrondId: string | null;
    }
  | {
      kind: "merge";
      frondId: string;
      priorStatus: FrondStatus;
      priorActiveFrondId: string;
      decisionId: string;
    };

/** One routing decision recorded in the journal with its inverse. Spec §4, §5, §11. */
export interface Decision {
  id: string;
  sessionId: string;
  /** Null only for `merge` — it isn't tied to one exchange. */
  leafletId: string | null;
  action: DecisionAction;
  target: string | null;
  /** The second frond, for a combine. */
  with?: string;
  /** Which router stage produced this decision: 0 (local), 2 (LLM escalation), or "manual" (a direct command — /fern stray, the "? " prefix, /fern switch, merge). */
  stage: 0 | 2 | "manual";
  /** Root ids this decision drew into the leaflet's context, if any. */
  rootsUsed?: string[];
  signals: string[];
  confidence: number;
  tokensBefore: number;
  tokensAfter: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  undone: boolean;
  inverse: DecisionInverse;
  createdAt: string;
}
