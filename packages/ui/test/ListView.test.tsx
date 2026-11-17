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
const { getLeaflets: getLeafletsMock } = apiMocks;

const { ListView } = await import("../src/screens/views/ListView");

const fronds: TreeFrond[] = [
  {
    id: "f1",
    name: "auth-refactor",
    status: "active",
    colorIndex: 0,
    leafletCount: 1,
  },
];

function leaflet(overrides: Partial<UiLeaflet>): UiLeaflet {
  return {
    turn: 1,
    frondName: "auth-refactor",
    isStray: false,
    strayFromFrondName: null,
    kind: "new",
    promptPreview: "fix the login bug",
    tokenCount: 400,
    confidence: 0.82,
    basis: null,
    filesTouchedCount: 2,
    ...overrides,
  };
}

beforeEach(() => {
  getLeafletsMock.mockReset();
  getLeafletsMock.mockImplementation(() =>
    Promise.resolve({ leaflets: [leaflet({})], total: 1 }),
  );
});

afterEach(cleanup);

test("renders the column header and a real leaflet row", async () => {
  render(
    <ListView
      projectPath="/repo"
      fronds={fronds}
      selection={null}
      onSelect={() => {}}
    />,
  );

  expect(screen.getByText("turn")).toBeDefined();
  expect(screen.getByText("frond")).toBeDefined();
  expect(screen.getByText("kind")).toBeDefined();
  expect(screen.getByText("prompt")).toBeDefined();
  expect(screen.getByText("context")).toBeDefined();
  expect(screen.getByText("basis")).toBeDefined();

  await waitFor(() => {
    expect(screen.getByText("fix the login bug")).toBeDefined();
  });
  expect(screen.getByText("auth-refactor")).toBeDefined();
  expect(screen.getByText("new")).toBeDefined();
  expect(screen.getByText("0.82")).toBeDefined();
});

test("a decision with no measured score shows what it rests on instead of a number", async () => {
  getLeafletsMock.mockImplementation(() =>
    Promise.resolve({
      leaflets: [
        leaflet({
          turn: 1,
          kind: "new",
          confidence: null,
          basis: "cue phrase",
        }),
        leaflet({
          turn: 2,
          kind: "return",
          confidence: null,
          basis: "manual",
        }),
      ],
      total: 2,
    }),
  );
  render(
    <ListView
      projectPath="/repo"
      fronds={fronds}
      selection={null}
      onSelect={() => {}}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("cue phrase")).toBeDefined();
  });
  expect(screen.getByText("manual")).toBeDefined();
  expect(screen.queryByText(/[0-9]\.[0-9][0-9]/)).toBeNull();
});

test("shows n/a for a leaflet with no matching Recent entry, and — (not a fabricated 1.00) for one with no real router score", async () => {
  getLeafletsMock.mockImplementation(() =>
    Promise.resolve({
      leaflets: [leaflet({ promptPreview: null, confidence: null })],
      total: 1,
    }),
  );
  render(
    <ListView
      projectPath="/repo"
      fronds={fronds}
      selection={null}
      onSelect={() => {}}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("n/a")).toBeDefined();
  });
  expect(screen.getByText("—")).toBeDefined();
});

test("renders a stray leaflet with its parent frond named", async () => {
  getLeafletsMock.mockImplementation(() =>
    Promise.resolve({
      leaflets: [
        leaflet({
          isStray: true,
          strayFromFrondName: "auth-refactor",
          kind: "stray",
          frondName: "stray",
        }),
      ],
      total: 1,
    }),
  );
  render(
    <ListView
      projectPath="/repo"
      fronds={fronds}
      selection={null}
      onSelect={() => {}}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("stray ← auth-refactor")).toBeDefined();
  });
});

test("clicking a row selects that leaflet's turn", async () => {
  const onSelect = mock(() => {});
  render(
    <ListView
      projectPath="/repo"
      fronds={fronds}
      selection={null}
      onSelect={onSelect}
    />,
  );

  const row = await waitFor(() => screen.getByText("fix the login bug"));
  fireEvent.click(row.closest("button") as HTMLButtonElement);

  expect(onSelect).toHaveBeenCalledWith({ kind: "leaflet", turn: 1 });
});

test("windows a large session instead of fetching every leaflet at once", async () => {
  getLeafletsMock.mockImplementation((_path: string, offset: number) =>
    Promise.resolve({
      leaflets: [
        leaflet({ turn: offset + 1, promptPreview: `turn ${offset + 1}` }),
      ],
      total: 4000,
    }),
  );
  render(
    <ListView
      projectPath="/repo"
      fronds={fronds}
      selection={null}
      onSelect={() => {}}
    />,
  );

  await waitFor(() => {
    expect(getLeafletsMock).toHaveBeenCalledWith("/repo", 0, 50);
  });
  expect(screen.getByText("1–50 of 4000")).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "next" }));

  await waitFor(() => {
    expect(getLeafletsMock).toHaveBeenCalledWith("/repo", 50, 50);
  });
  await waitFor(() => {
    expect(screen.getByText("turn 51")).toBeDefined();
  });
});
