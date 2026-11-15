import "./dom-setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  StatusResponse,
  TreeFrond,
  UiLeafletPage,
  UiStats,
} from "../src/api/types";
import { createApiClientMocks } from "./mock-api-client";

const fronds: TreeFrond[] = [
  {
    id: "f1",
    name: "auth-refactor",
    status: "active",
    colorIndex: 1,
    leafletCount: 3,
  },
  {
    id: "f2",
    name: "docker-build",
    status: "resting",
    colorIndex: 2,
    leafletCount: 2,
  },
];
const leaflets: UiLeafletPage = {
  leaflets: [
    {
      turn: 0,
      frondName: "stem",
      isStray: false,
      strayFromFrondName: null,
      kind: "continue",
      promptPreview: null,
      tokenCount: 5,
      confidence: 0.9,
      filesTouchedCount: 0,
    },
    {
      turn: 1,
      frondName: "auth-refactor",
      isStray: false,
      strayFromFrondName: null,
      kind: "new",
      promptPreview: "fix auth",
      tokenCount: 6,
      confidence: 0.8,
      filesTouchedCount: 1,
    },
  ],
  total: 2,
};
const stats: UiStats = {
  frondCount: 1,
  strayCount: 0,
  frondOpenings: 1,
  rootsUsed: 0,
  undo: { count: 1, of: 6 },
  ctxKeptOut: "n/a",
};
const status: StatusResponse = {
  activeFrondName: "auth-refactor",
  frondCount: 1,
  strayCount: 0,
  leafletCount: 2,
  mode: "suggest",
};

const apiMocks = createApiClientMocks();
mock.module("../src/api/client", () => apiMocks);
const {
  getFronds: getFrondsMock,
  getLeaflets: getLeafletsMock,
  getStats: getStatsMock,
  getStatus: getStatusMock,
  postMode: postModeMock,
  postUndo: postUndoMock,
  getFrondBrief: getFrondBriefMock,
} = apiMocks;

const { AppShell } = await import("../src/screens/AppShell");

beforeEach(() => {
  for (const m of [
    getFrondsMock,
    getLeafletsMock,
    getStatsMock,
    getStatusMock,
    postModeMock,
    postUndoMock,
    getFrondBriefMock,
  ]) {
    m.mockClear();
  }
  getFrondsMock.mockImplementation(() => Promise.resolve({ fronds }));
  getLeafletsMock.mockImplementation(() => Promise.resolve(leaflets));
  getStatsMock.mockImplementation(() => Promise.resolve(stats));
  getStatusMock.mockImplementation(() => Promise.resolve(status));
  postModeMock.mockImplementation(() => Promise.resolve(undefined));
  postUndoMock.mockImplementation(() =>
    Promise.resolve({ receipt: "fern ▸ undone new" }),
  );
  getFrondBriefMock.mockImplementation(() =>
    Promise.resolve({
      name: "auth-refactor",
      goal: "Fix auth",
      decided: "",
      open: "",
      files: "",
      notes: "",
    }),
  );
});

afterEach(cleanup);

test("renders the header, view tabs, mode pill, and stat tiles from real fetched data", async () => {
  render(<AppShell projectPath="/repo" projectName="shop-api" />);

  await waitFor(() => {
    expect(screen.getByText("shop-api")).toBeDefined();
  });
  expect(screen.getByRole("tab", { name: "Fern" })).toBeDefined();
  expect(screen.getByRole("tab", { name: "List" })).toBeDefined();
  expect(screen.getByRole("tab", { name: "Categories" })).toBeDefined();

  await waitFor(() => {
    expect(screen.getByText("1 of 6")).toBeDefined(); // undo rate tile
  });
  expect(screen.getAllByText("n/a").length).toBeGreaterThan(0); // ctx-kept-out tile
});

test("switching to List shows real leaflet rows, not a crash", async () => {
  render(<AppShell projectPath="/repo" projectName="shop-api" />);
  await waitFor(() => expect(getFrondsMock).toHaveBeenCalled());

  fireEvent.click(screen.getByRole("tab", { name: "List" }));

  await waitFor(() => {
    expect(screen.getByText("fix auth")).toBeDefined();
  });
});

test("switching to Categories shows real frond cards, not a crash", async () => {
  render(<AppShell projectPath="/repo" projectName="shop-api" />);
  await waitFor(() => expect(getFrondsMock).toHaveBeenCalled());

  fireEvent.click(screen.getByRole("tab", { name: "Categories" }));

  await waitFor(() => {
    expect(
      screen.getByText("Off-topic questions, kept off every frond"),
    ).toBeDefined();
  });
  expect(screen.getByText("Memories from earlier sessions")).toBeDefined();
});

test("changing the mode pill calls postMode with the new mode", async () => {
  render(<AppShell projectPath="/repo" projectName="shop-api" />);
  await waitFor(() => expect(getStatusMock).toHaveBeenCalled());

  fireEvent.click(screen.getByRole("button", { name: /Routing mode/ }));
  fireEvent.click(screen.getByRole("option", { name: "observe mode" }));

  await waitFor(() => {
    expect(postModeMock).toHaveBeenCalledWith("/repo", "observe");
  });
});

test("clicking undo routing calls postUndo and reloads", async () => {
  render(<AppShell projectPath="/repo" projectName="shop-api" />);
  await waitFor(() => expect(getFrondsMock).toHaveBeenCalled());

  fireEvent.click(screen.getByRole("button", { name: "undo routing" }));

  await waitFor(() => {
    expect(postUndoMock).toHaveBeenCalledWith("/repo");
  });
  await waitFor(() => {
    // reload() runs again after undo — getFronds called at least twice (initial + reload)
    expect(getFrondsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

test("selecting a frond in the legend fetches and shows its brief goal", async () => {
  render(<AppShell projectPath="/repo" projectName="shop-api" />);
  await waitFor(() => expect(screen.getByText("auth-refactor")).toBeDefined());

  fireEvent.click(screen.getByText("auth-refactor"));

  await waitFor(() => {
    expect(getFrondBriefMock).toHaveBeenCalledWith("/repo", "auth-refactor");
  });
  await waitFor(() => {
    expect(screen.getByText("Fix auth")).toBeDefined();
  });
});
