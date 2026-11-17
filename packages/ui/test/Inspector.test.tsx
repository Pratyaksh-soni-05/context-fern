import "./dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type {
  TreeFrond as TreeFrondType,
  UiLeaflet as UiLeafletType,
} from "../src/api/types";
import { createApiClientMocks } from "./mock-api-client";

const apiMocks = createApiClientMocks();
mock.module("../src/api/client", () => apiMocks);

const { Inspector } = await import("../src/components/Inspector");

afterEach(cleanup);

function frond(overrides: Partial<TreeFrondType> = {}): TreeFrondType {
  return {
    id: "frond-1",
    name: "auth-refactor",
    status: "active",
    colorIndex: 1,
    leafletCount: 1,
    ...overrides,
  };
}

function leaflet(overrides: Partial<UiLeafletType> = {}): UiLeafletType {
  return {
    turn: 1,
    frondName: "auth-refactor",
    isStray: false,
    strayFromFrondName: null,
    kind: "continue",
    promptPreview: null,
    tokenCount: 5,
    confidence: null,
    basis: null,
    filesTouchedCount: 0,
    ...overrides,
  };
}

test("default headline is a real computed count, not the fabricated 'Nothing lost.' claim", () => {
  render(
    <Inspector
      projectPath="/repo"
      fronds={[frond(), frond({ id: "frond-2", name: "docker-build" })]}
      leaflets={[leaflet({ turn: 1 }), leaflet({ turn: 2 })]}
      strayCount={0}
      rootsUsed={0}
      selection={null}
      onSelect={() => {}}
      onUndo={() => {}}
      undoBusy={false}
    />,
  );
  expect(screen.getByText("2 leaflets · 2 fronds")).toBeDefined();
  expect(screen.queryByText("Nothing lost.")).toBeNull();
});

test("default headline names the frond-opening leaflets, so a count one higher than the prompts typed is explained", () => {
  render(
    <Inspector
      projectPath="/repo"
      fronds={[frond()]}
      leaflets={[
        leaflet({ turn: 1 }),
        leaflet({ turn: 2 }),
        leaflet({ turn: 3, kind: "new" }),
      ]}
      strayCount={0}
      frondOpenings={1}
      rootsUsed={0}
      selection={null}
      onSelect={() => {}}
      onUndo={() => {}}
      undoBusy={false}
    />,
  );
  expect(
    screen.getByText("3 leaflets · 1 frond · 1 frond opening"),
  ).toBeDefined();
});

test("default headline reads 'No turns yet.' for a genuinely empty session", () => {
  render(
    <Inspector
      projectPath="/repo"
      fronds={[]}
      leaflets={[]}
      strayCount={0}
      rootsUsed={0}
      selection={null}
      onSelect={() => {}}
      onUndo={() => {}}
      undoBusy={false}
    />,
  );
  expect(screen.getByText("No turns yet.")).toBeDefined();
});

test("a forced continue (confidence null) shows 'no score', never a fabricated 1.00", () => {
  render(
    <Inspector
      projectPath="/repo"
      fronds={[frond()]}
      leaflets={[leaflet({ turn: 1, confidence: null })]}
      strayCount={0}
      rootsUsed={0}
      selection={{ kind: "leaflet", turn: 1 }}
      onSelect={() => {}}
      onUndo={() => {}}
      undoBusy={false}
    />,
  );
  expect(screen.getByText("continue · no score")).toBeDefined();
  expect(screen.queryByText(/1\.00/)).toBeNull();
});

test("a decision with no measured score names what it rests on in the routing line, not a number", () => {
  render(
    <Inspector
      projectPath="/repo"
      fronds={[frond()]}
      leaflets={[
        leaflet({
          turn: 1,
          kind: "new",
          confidence: null,
          basis: "cue phrase",
        }),
      ]}
      strayCount={0}
      rootsUsed={0}
      selection={{ kind: "leaflet", turn: 1 }}
      onSelect={() => {}}
      onUndo={() => {}}
      undoBusy={false}
    />,
  );
  expect(screen.getByText("new · cue phrase")).toBeDefined();
});

test("a leaflet with a real router score shows the real confidence number", () => {
  render(
    <Inspector
      projectPath="/repo"
      fronds={[frond()]}
      leaflets={[leaflet({ turn: 1, kind: "new", confidence: 0.76 })]}
      strayCount={0}
      rootsUsed={0}
      selection={{ kind: "leaflet", turn: 1 }}
      onSelect={() => {}}
      onUndo={() => {}}
      undoBusy={false}
    />,
  );
  expect(screen.getByText("new · confidence 0.76")).toBeDefined();
});

test("strays with no kept prompt text show 'text not kept', not a bare n/a", () => {
  render(
    <Inspector
      projectPath="/repo"
      fronds={[]}
      leaflets={[
        leaflet({
          turn: 3,
          isStray: true,
          strayFromFrondName: "auth-refactor",
          promptPreview: null,
        }),
      ]}
      strayCount={1}
      rootsUsed={0}
      selection={{ kind: "strays" }}
      onSelect={() => {}}
      onUndo={() => {}}
      undoBusy={false}
    />,
  );
  expect(screen.getByText("text not kept")).toBeDefined();
});

test("honestly notes strays that exist (per strayCount) but aren't in the capped leaflets window", () => {
  render(
    <Inspector
      projectPath="/repo"
      fronds={[frond()]}
      leaflets={[
        leaflet({
          turn: 9,
          isStray: true,
          strayFromFrondName: "auth-refactor",
          promptPreview: "a real kept prompt",
        }),
      ]}
      strayCount={5}
      rootsUsed={0}
      selection={{ kind: "strays" }}
      onSelect={() => {}}
      onUndo={() => {}}
      undoBusy={false}
    />,
  );
  expect(screen.getByText("a real kept prompt")).toBeDefined();
  expect(
    screen.getByText("4 more — see List for the complete history"),
  ).toBeDefined();
});
