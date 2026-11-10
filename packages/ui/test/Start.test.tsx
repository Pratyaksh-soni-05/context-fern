import "./dom-setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createApiClientMocks } from "./mock-api-client";

const apiMocks = createApiClientMocks();
mock.module("../src/api/client", () => apiMocks);
const { listProjects: listProjectsMock, openProjectPath: openProjectPathMock } =
  apiMocks;

const { Start } = await import("../src/screens/Start");
const { ApiError: MockedApiError } = await import("../src/api/client");

beforeEach(() => {
  listProjectsMock.mockReset();
  listProjectsMock.mockImplementation(() => Promise.resolve({ projects: [] }));
  openProjectPathMock.mockReset();
  openProjectPathMock.mockImplementation((path: string) =>
    Promise.resolve({ path, name: "whatever" }),
  );
});

afterEach(cleanup);

test("renders the heading and footer copy, with no login/account language anywhere", async () => {
  render(<Start onOpen={() => {}} />);
  expect(screen.getByRole("heading", { name: "Open a fern" })).toBeDefined();
  await waitFor(() => {
    expect(screen.getByText(/No account needed/)).toBeDefined();
  });
  expect(screen.getByText(/Nothing here leaves this machine/)).toBeDefined();
});

test("shows the recent projects list once loaded, with real session counts", async () => {
  listProjectsMock.mockImplementation(() =>
    Promise.resolve({
      projects: [
        {
          path: "/code/shop-api",
          name: "shop-api",
          lastOpenedAt: "x",
          sessionCount: 14,
        },
        {
          path: "/projects/alpha",
          name: "alpha-context-tree",
          lastOpenedAt: "x",
          sessionCount: 1,
        },
      ],
    }),
  );
  render(<Start onOpen={() => {}} />);

  await waitFor(() => {
    expect(screen.getByText("shop-api")).toBeDefined();
  });
  expect(screen.getByText("14 sessions")).toBeDefined();
  expect(screen.getByText("alpha-context-tree")).toBeDefined();
  expect(screen.getByText("1 session")).toBeDefined(); // singular, not "1 sessions"
});

test("renders no recent-projects list at all when there are none yet", async () => {
  render(<Start onOpen={() => {}} />);
  await waitFor(() => {
    expect(listProjectsMock).toHaveBeenCalled();
  });
  expect(screen.queryByRole("list", { name: "Recent projects" })).toBeNull();
});

test("clicking a recent project opens it", async () => {
  listProjectsMock.mockImplementation(() =>
    Promise.resolve({
      projects: [
        {
          path: "/code/shop-api",
          name: "shop-api",
          lastOpenedAt: "x",
          sessionCount: 14,
        },
      ],
    }),
  );
  const onOpen = mock(() => {});
  render(<Start onOpen={onOpen} />);

  const row = await waitFor(() => screen.getByText("shop-api"));
  fireEvent.click(row);

  await waitFor(() => {
    expect(openProjectPathMock).toHaveBeenCalledWith("/code/shop-api");
  });
  await waitFor(() => {
    expect(onOpen).toHaveBeenCalledWith({
      path: "/code/shop-api",
      name: "whatever",
    });
  });
});

test("submitting the folder form opens that path", async () => {
  const onOpen = mock(() => {});
  render(<Start onOpen={onOpen} />);

  const input = screen.getByLabelText("Project folder");
  fireEvent.change(input, { target: { value: "/code/my-project" } });
  fireEvent.click(screen.getByRole("button", { name: "Open fern" }));

  await waitFor(() => {
    expect(openProjectPathMock).toHaveBeenCalledWith("/code/my-project");
  });
});

test("the Open fern button is disabled until a path is typed", async () => {
  render(<Start onOpen={() => {}} />);
  await waitFor(() => expect(listProjectsMock).toHaveBeenCalled());

  const button = screen.getByRole("button", {
    name: "Open fern",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);

  const input = screen.getByLabelText("Project folder");
  fireEvent.change(input, { target: { value: "/code/x" } });
  expect(button.disabled).toBe(false);
});

test("shows the server's one-line fix message when a path has no .fern/fern.db", async () => {
  openProjectPathMock.mockImplementation(() =>
    Promise.reject(
      new MockedApiError(
        "no .fern/fern.db at that path — run `fern init` there first",
        404,
      ),
    ),
  );
  render(<Start onOpen={() => {}} />);

  const input = screen.getByLabelText("Project folder");
  fireEvent.change(input, { target: { value: "/code/uninitialized" } });
  fireEvent.click(screen.getByRole("button", { name: "Open fern" }));

  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toContain("fern init");
  });
});

test("surfaces main.tsx's initialAuthError immediately, even though the recent-projects list itself loads fine", async () => {
  render(
    <Start
      onOpen={() => {}}
      initialAuthError="That link expired. Run `fern ui` again."
    />,
  );

  expect(screen.getByRole("alert").textContent).toBe(
    "That link expired. Run `fern ui` again.",
  );
  // Not conflated with "no recent projects yet" — the list load still
  // happens on its own, independent of the auth error shown above it.
  await waitFor(() => {
    expect(listProjectsMock).toHaveBeenCalled();
  });
});

test("submitting the folder form clears a stale initialAuthError, not just a later one", async () => {
  render(
    <Start
      onOpen={() => {}}
      initialAuthError="Your browser is blocking the session cookie for 127.0.0.1 — allow cookies for this site, or try a different browser."
    />,
  );
  expect(screen.getByRole("alert")).toBeDefined();

  const input = screen.getByLabelText("Project folder");
  fireEvent.change(input, { target: { value: "/code/x" } });
  fireEvent.click(screen.getByRole("button", { name: "Open fern" }));

  await waitFor(() => {
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
