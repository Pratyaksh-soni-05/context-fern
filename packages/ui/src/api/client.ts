// Fetch wrapper for the daemon's JSON API. Every call is same-origin
// (the daemon serves this page itself, or Vite's dev proxy makes it
// look that way) — the session cookie minted by exchangeCode() is sent
// automatically by the browser, no credentials option needed. Every
// response is unwrapped from the daemon's `{ ok, ...rest }` /
// `{ ok: false, error }` envelope into either the payload or a thrown
// `ApiError`.

import type {
  FrondBriefResponse,
  HeatmapResponse,
  Mode,
  RecentProject,
  StatusResponse,
  TreeFrond,
  UiLeafletPage,
  UiStats,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });

  if (res.status === 204) return undefined as T;

  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  } & Record<string, unknown>;

  if (!res.ok || json.ok === false) {
    throw new ApiError(
      json.error ?? `request failed (${res.status})`,
      res.status,
    );
  }
  const { ok, ...rest } = json;
  return rest as T;
}

/** The one-time code -> session cookie exchange — see main.tsx. */
export function exchangeCode(code: string): Promise<void> {
  return request("POST", "/session", { code });
}

export function listProjects(): Promise<{ projects: RecentProject[] }> {
  return request("GET", "/projects");
}

export function openProjectPath(
  path: string,
): Promise<{ path: string; name: string }> {
  return request("POST", "/projects/open", { path });
}

export function getFronds(
  projectPath: string,
): Promise<{ fronds: TreeFrond[] }> {
  return request(
    "GET",
    `/fronds?projectPath=${encodeURIComponent(projectPath)}`,
  );
}

export function getLeaflets(
  projectPath: string,
  offset: number,
  limit: number,
): Promise<UiLeafletPage> {
  return request(
    "GET",
    `/leaflets?projectPath=${encodeURIComponent(projectPath)}&offset=${offset}&limit=${limit}`,
  );
}

export function getStats(projectPath: string): Promise<UiStats> {
  return request(
    "GET",
    `/stats?projectPath=${encodeURIComponent(projectPath)}`,
  );
}

export function getHeatmap(projectPath: string): Promise<HeatmapResponse> {
  return request(
    "GET",
    `/heatmap?projectPath=${encodeURIComponent(projectPath)}`,
  );
}

export function getStatus(projectPath: string): Promise<StatusResponse> {
  return request(
    "GET",
    `/status?projectPath=${encodeURIComponent(projectPath)}`,
  );
}

export function postUndo(projectPath: string): Promise<{ receipt: string }> {
  return request("POST", "/undo", { projectPath });
}

export function postMode(projectPath: string, mode: Mode): Promise<void> {
  return request("POST", "/mode", { projectPath, mode });
}

export function getFrondBrief(
  projectPath: string,
  frondName: string,
): Promise<FrondBriefResponse> {
  return request(
    "GET",
    `/frond/${encodeURIComponent(frondName)}/brief?projectPath=${encodeURIComponent(projectPath)}`,
  );
}
