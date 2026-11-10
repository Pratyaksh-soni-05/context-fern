import "./dom-setup";

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModePill } from "../src/components/ModePill";

afterEach(cleanup);

test("closed by default — trigger shows the current mode, no listbox in the DOM", () => {
  render(<ModePill mode="suggest" onChange={() => {}} />);
  expect(
    screen.getByRole("button", { name: "Routing mode: suggest mode" }),
  ).toBeDefined();
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("clicking the trigger opens a real listbox with all three options, isolate disabled", () => {
  render(<ModePill mode="suggest" onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /Routing mode/ }));

  expect(screen.getByRole("listbox", { name: "Routing mode" })).toBeDefined();
  const options = screen.getAllByRole("option");
  expect(options).toHaveLength(3);

  const isolateOption = screen.getByRole("option", {
    name: /isolate mode/,
  }) as HTMLButtonElement;
  expect(isolateOption.disabled).toBe(true);
  const observeOption = screen.getByRole("option", {
    name: "observe mode",
  }) as HTMLButtonElement;
  const suggestOption = screen.getByRole("option", {
    name: "suggest mode",
  }) as HTMLButtonElement;
  expect(observeOption.disabled).toBe(false);
  expect(suggestOption.disabled).toBe(false);
});

test("still shows isolate as the current, correctly-selected mode if something outside the UI already set it — never misrepresents real state", () => {
  render(<ModePill mode="isolate" onChange={() => {}} />);
  expect(
    screen.getByRole("button", { name: /Routing mode: isolate mode/ }),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: /Routing mode/ }));
  const isolateOption = screen.getByRole("option", { name: /isolate mode/ });
  expect(isolateOption.getAttribute("aria-selected")).toBe("true");
});

test("clicking a real option calls onChange and closes the listbox", () => {
  const calls: string[] = [];
  render(
    <ModePill
      mode="suggest"
      onChange={(m) => {
        calls.push(m);
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Routing mode/ }));
  fireEvent.click(screen.getByRole("option", { name: "observe mode" }));

  expect(calls).toEqual(["observe"]);
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("clicking the disabled isolate option never calls onChange", () => {
  let called = false;
  render(
    <ModePill
      mode="suggest"
      onChange={() => {
        called = true;
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Routing mode/ }));
  fireEvent.click(screen.getByRole("option", { name: /isolate mode/ }));

  expect(called).toBe(false);
});

test("Escape closes the listbox and returns focus to the trigger", () => {
  render(<ModePill mode="suggest" onChange={() => {}} />);
  const trigger = screen.getByRole("button", { name: /Routing mode/ });
  fireEvent.click(trigger);
  const suggestOption = screen.getByRole("option", { name: "suggest mode" });
  fireEvent.keyDown(suggestOption, { key: "Escape" });

  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("ArrowDown from an option moves focus to the next enabled option, skipping disabled ones", () => {
  render(<ModePill mode="suggest" onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /Routing mode/ }));
  const observeOption = screen.getByRole("option", { name: "observe mode" });
  const suggestOption = screen.getByRole("option", { name: "suggest mode" });

  fireEvent.keyDown(suggestOption, { key: "ArrowDown" });
  // isolate is disabled, so ArrowDown from suggest wraps back to observe.
  expect(document.activeElement).toBe(observeOption);
});
