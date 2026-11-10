import "./dom-setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { TreeFrond, UiLeaflet } from "../src/api/types";
import { createApiClientMocks } from "./mock-api-client";

const apiMocks = createApiClientMocks();
mock.module("../src/api/client", () => apiMocks);
const { getFrondBrief: getFrondBriefMock, getHeatmap: getHeatmapMock } =
  apiMocks;

const { CategoriesView } = await import("../src/screens/views/CategoriesView");

const fronds: TreeFrond[] = [
  {
    id: "f1",
    name: "auth-refactor",
    status: "active",
    colorIndex: 0,
    leafletCount: 3,
  },
  {
    id: "f2",
    name: "flaky-test",
    status: "merged",
    colorIndex: 1,
    leafletCount: 2,
  },
];

function leaflet(overrides: Partial<UiLeaflet>): UiLeaflet {
  return {
    turn: 1,
    frondName: "auth-refactor",
    isStray: false,
    strayFromFrondName: null,
    kind: "new",
    promptPreview: null,
    tokenCount: 100,
    confidence: 0.8,
    filesTouchedCount: 1,
    ...overrides,
  };
}

const leaflets: UiLeaflet[] = [
  leaflet({ turn: 1, frondName: "auth-refactor" }),
  leaflet({
    turn: 2,
    isStray: true,
    frondName: "stray",
    strayFromFrondName: "auth-refactor",
    promptPreview: "what does PKCE stand for?",
  }),
];

beforeEach(() => {
  getFrondBriefMock.mockReset();
  getFrondBriefMock.mockImplementation((_path: string, name: string) =>
    Promise.resolve({
      name,
      goal: `Goal for ${name}`,
      decided: `Decided for ${name}`,
      open: "",
      files: "",
      notes: "",
    }),
  );
  getHeatmapMock.mockReset();
  getHeatmapMock.mockImplementation(() =>
    Promise.resolve({
      rows: [
        { frondName: "stem", cells: ["stem", null] },
        { frondName: "auth-refactor", cells: [null, "auth-refactor"] },
        { frondName: "stray", cells: [null, null] },
      ],
      turnsPerCell: 1,
    }),
  );
});

afterEach(cleanup);

test("renders a card per frond with its real goal and decided text", async () => {
  render(
    <CategoriesView
      projectPath="/repo"
      fronds={fronds}
      leaflets={leaflets}
      strayCount={1}
      rootsUsed={0}
      selection={null}
      onSelect={() => {}}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("Goal for auth-refactor")).toBeDefined();
  });
  expect(screen.getByText("Decided: Decided for auth-refactor")).toBeDefined();
  expect(screen.getByText("3 leaflets · 1 stray")).toBeDefined();
  expect(screen.getByText("2 leaflets · merged")).toBeDefined();
});

test("renders the strays card with a real caught prompt, and the roots card genuinely empty", async () => {
  render(
    <CategoriesView
      projectPath="/repo"
      fronds={fronds}
      leaflets={leaflets}
      strayCount={1}
      rootsUsed={0}
      selection={null}
      onSelect={() => {}}
    />,
  );

  await waitFor(() => {
    expect(getFrondBriefMock).toHaveBeenCalled();
  });
  expect(screen.getByText("1 caught")).toBeDefined();
  // The stray's full line — turn, source frond, and its real prompt
  // text — not just the prompt fragment in isolation, since it now
  // renders alongside "turn N · from X ·" in the same list item.
  const strayList = screen.getByRole("list", { hidden: true });
  expect(strayList.textContent).toContain("turn 2");
  expect(strayList.textContent).toContain("auth-refactor");
  expect(strayList.textContent).toContain("what does PKCE stand for?");
  expect(screen.getByText("0 used")).toBeDefined();
  expect(screen.getByText("None yet.")).toBeDefined();
});

test("lists every stray individually — turn, source frond, and 'text not kept' when no prompt was preserved — even when strayCount says there are more than render with text", async () => {
  const twoStrays: UiLeaflet[] = [
    leaflet({ turn: 1, frondName: "auth-refactor" }),
    leaflet({
      turn: 2,
      isStray: true,
      frondName: "stray",
      strayFromFrondName: "auth-refactor",
      promptPreview: null, // the common case — no Recent entry was ever tagged for this turn
    }),
    leaflet({
      turn: 5,
      isStray: true,
      frondName: "stray",
      strayFromFrondName: "flaky-test",
      promptPreview: null,
    }),
  ];
  render(
    <CategoriesView
      projectPath="/repo"
      fronds={fronds}
      leaflets={twoStrays}
      strayCount={2}
      rootsUsed={0}
      selection={null}
      onSelect={() => {}}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("2 caught")).toBeDefined();
  });
  // Never "None yet." on the strays card itself when strayCount/
  // strayEntries say there really are some — the real bug this fixes:
  // "2 caught" next to "None yet." when neither stray happened to have
  // a kept prompt. (The roots card legitimately always shows "None
  // yet." — unscoped, this assertion would wrongly fail against that.)
  const straysCard = screen.getByText("2 caught").closest("button");
  expect(straysCard?.textContent).not.toContain("None yet.");
  const items = screen.getAllByRole("listitem", { hidden: true });
  expect(items).toHaveLength(2);
  expect(items[0]?.textContent).toContain("turn 2");
  expect(items[0]?.textContent).toContain("auth-refactor");
  expect(items[0]?.textContent).toContain("text not kept");
  expect(items[1]?.textContent).toContain("turn 5");
  expect(items[1]?.textContent).toContain("flaky-test");
  expect(items[1]?.textContent).toContain("text not kept");
});

test("honestly notes strays that exist (per strayCount) but aren't in the capped leaflets window, instead of silently listing fewer than the header count", async () => {
  // AppShell only ever passes a graph-capped leaflets window (see its
  // own GRAPH_LEAFLET_CAP) — strayCount (from /stats) is the real,
  // uncapped total, so a long session can genuinely have more strays
  // than this component can enumerate from `leaflets` alone.
  const oneStrayInWindow = [
    leaflet({
      turn: 9,
      isStray: true,
      frondName: "stray",
      strayFromFrondName: "auth-refactor",
      promptPreview: "a real kept prompt",
    }),
  ];
  render(
    <CategoriesView
      projectPath="/repo"
      fronds={fronds}
      leaflets={oneStrayInWindow}
      strayCount={5}
      rootsUsed={0}
      selection={null}
      onSelect={() => {}}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("5 caught")).toBeDefined();
  });
  const straysCard = screen.getByText("5 caught").closest("button");
  expect(straysCard?.textContent).toContain("a real kept prompt");
  expect(straysCard?.textContent).toContain(
    "+4 more not shown here — see List for the complete history.",
  );
});

test("clicking a frond card selects it", async () => {
  const onSelect = mock(() => {});
  render(
    <CategoriesView
      projectPath="/repo"
      fronds={fronds}
      leaflets={leaflets}
      strayCount={1}
      rootsUsed={0}
      selection={null}
      onSelect={onSelect}
    />,
  );

  const card = await waitFor(() => screen.getByText("auth-refactor"));
  fireEvent.click(card.closest("button") as HTMLButtonElement);

  expect(onSelect).toHaveBeenCalledWith({ kind: "frond", id: "f1" });
});

test("shows the heatmap's real turnsPerCell compression, never silently", async () => {
  getHeatmapMock.mockImplementation(() =>
    Promise.resolve({
      rows: [{ frondName: "stem", cells: [null] }],
      turnsPerCell: 7,
    }),
  );
  render(
    <CategoriesView
      projectPath="/repo"
      fronds={fronds}
      leaflets={leaflets}
      strayCount={1}
      rootsUsed={0}
      selection={null}
      onSelect={() => {}}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("7 turns per cell")).toBeDefined();
  });
  await waitFor(() => {
    expect(getFrondBriefMock).toHaveBeenCalled();
  });
});
