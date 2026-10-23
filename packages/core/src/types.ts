// Public types. Changing these needs an entry in docs/decisions.md (see CLAUDE.md).

export type Mode = "observe" | "suggest" | "isolate";

export type BranchStatus = "active" | "parked" | "merged";

export type RouterActionType = "continue" | "new" | "return" | "combine";

export type TurnRole = "user" | "assistant" | "tool";

/** One agent conversation in one project directory. Spec §4. */
export interface Session {
  id: string;
  agent: string;
  projectPath: string;
  startedAt: string;
  mode: Mode;
}

/** A topic thread with a name, parent, status, centroid vector and brief. Spec §4. */
export interface Branch {
  id: string;
  sessionId: string;
  parentId: string | null;
  name: string;
  status: BranchStatus;
  centroid: number[] | null;
  briefPath: string;
  createdAt: string;
}

/** One turn on a branch. Content is never stored, only a hash and counts. Spec §4, §11. */
export interface Turn {
  id: string;
  sessionId: string;
  branchId: string;
  role: TurnRole;
  contentHash: string;
  tokenCount: number;
  filesTouched: string[];
  createdAt: string;
}

/** Router output for one turn. Spec §5. */
export interface RouterAction {
  action: RouterActionType;
  target?: string;
  confidence: number;
  signals: string[];
}

/** One routing decision recorded in the journal. Spec §4, §11. */
export interface Decision {
  id: string;
  turnId: string;
  action: RouterActionType;
  target: string | null;
  signals: string[];
  confidence: number;
  tokensBefore: number;
  tokensAfter: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  undone: boolean;
  createdAt: string;
}
