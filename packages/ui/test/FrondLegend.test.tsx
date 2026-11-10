import "./dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TreeFrond } from "../src/api/types";
import { FrondLegend } from "../src/components/FrondLegend";

const fronds: TreeFrond[] = [
  {
    id: "f1",
    name: "auth-refactor",
    status: "active",
    colorIndex: 0,
    leafletCount: 4,
  },
  {
    id: "f2",
    name: "docker-build",
    status: "active",
    colorIndex: 1,
    leafletCount: 3,
  },
];

afterEach(cleanup);

test("is a listbox of options, not a tree, with the current selection marked", () => {
  render(
    <FrondLegend
      fronds={fronds}
      strayCount={2}
      rootsUsed={0}
      selection={{ kind: "frond", id: "f1" }}
      onSelect={() => {}}
    />,
  );

  expect(
    screen.getByRole("listbox", { name: "This fern's fronds" }),
  ).toBeDefined();
  const options = screen.getAllByRole("option");
  expect(options).toHaveLength(5); // stem, auth-refactor, docker-build, strays, roots

  const selected = screen.getByRole("option", { selected: true });
  expect(selected.textContent).toContain("auth-refactor");
});

test("only the active option (or the first, with no selection) is tab-reachable; arrow keys roam the rest", () => {
  render(
    <FrondLegend
      fronds={fronds}
      strayCount={2}
      rootsUsed={0}
      selection={null}
      onSelect={() => {}}
    />,
  );

  const options = screen.getAllByRole("option");
  expect(options.map((o) => o.getAttribute("tabindex"))).toEqual([
    "0",
    "-1",
    "-1",
    "-1",
    "-1",
  ]);

  const first = options[0] as HTMLElement;
  const second = options[1] as HTMLElement;
  const last = options[options.length - 1] as HTMLElement;

  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(second);

  fireEvent.keyDown(second, { key: "ArrowUp" });
  expect(document.activeElement).toBe(first);

  fireEvent.keyDown(first, { key: "End" });
  expect(document.activeElement).toBe(last);

  fireEvent.keyDown(last, { key: "Home" });
  expect(document.activeElement).toBe(first);
});

test("clicking an option selects it; clicking the selected option again clears the selection", () => {
  const onSelect = mock(() => {});
  render(
    <FrondLegend
      fronds={fronds}
      strayCount={2}
      rootsUsed={0}
      selection={{ kind: "frond", id: "f2" }}
      onSelect={onSelect}
    />,
  );

  fireEvent.click(screen.getByText("docker-build"));
  expect(onSelect).toHaveBeenCalledWith(null);

  fireEvent.click(screen.getByText("auth-refactor"));
  expect(onSelect).toHaveBeenCalledWith({ kind: "frond", id: "f1" });
});
