// bun:test's mock.module() patches the real module in the shared,
// process-wide module registry, not just the calling file's own
// import — every test file importing "../src/api/client" during the
// same `bun test` run sees whichever mock.module() call last won the
// race, regardless of which file's tests are actually running. A
// factory missing even one export breaks any OTHER component (e.g.
// AppShell.tsx needs getFronds/getStats/...; Start.tsx needs
// listProjects/ApiError) that happens to import the real module while
// an incomplete mock is active. One shared, complete factory — not
// each test file hand-rolling its own partial one — is what keeps this
// from silently breaking again the next time either file's mock
// drifts from the real module's exports. See docs/decisions.md.

import { mock } from "bun:test";
import type {
  FrondBriefResponse,
  HeatmapResponse,
  RecentProject,
  StatusResponse,
  TreeFrond,
  UiLeafletPage,
  UiStats,
} from "../src/api/types";

export class MockApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function createApiClientMocks() {
  return {
    ApiError: MockApiError,
    exchangeCode: mock(() => Promise.resolve(undefined)),
    listProjects: mock(() =>
      Promise.resolve({ projects: [] as RecentProject[] }),
    ),
    openProjectPath: mock((path: string) =>
      Promise.resolve({ path, name: "whatever" }),
    ),
    getFronds: mock(() => Promise.resolve({ fronds: [] as TreeFrond[] })),
    getLeaflets: mock((_projectPath: string, _offset: number, _limit: number) =>
      Promise.resolve({ leaflets: [], total: 0 } as UiLeafletPage),
    ),
    getStats: mock(() =>
      Promise.resolve({
        frondCount: 0,
        strayCount: 0,
        rootsUsed: 0,
        undo: null,
        ctxKeptOut: "n/a",
      } as UiStats),
    ),
    getHeatmap: mock(() =>
      Promise.resolve({ rows: [], turnsPerCell: 1 } as HeatmapResponse),
    ),
    getStatus: mock(() =>
      Promise.resolve({
        activeFrondName: null,
        frondCount: 0,
        strayCount: 0,
        leafletCount: 0,
        mode: "suggest",
      } as StatusResponse),
    ),
    postMode: mock(() => Promise.resolve(undefined)),
    postUndo: mock(() => Promise.resolve({ receipt: "" })),
    getFrondBrief: mock((_projectPath: string, _frondName: string) =>
      Promise.resolve({
        name: "",
        goal: "",
        decided: "",
        open: "",
        files: "",
        notes: "",
      } as FrondBriefResponse),
    ),
  };
}
