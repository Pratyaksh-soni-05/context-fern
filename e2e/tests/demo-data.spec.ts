// Confirms `bun run demo`'s dataset (scripts/demo-seed.ts's DEMO_PLAN,
// seeded into a second project by run-fixture-daemon.ts) actually shows
// up correctly across the real UI: the List view's row/pagination
// count, the Categories view's per-frond leaflet/stray counts and the
// merged card, and the App shell's stat tiles (fronds, strays, undo
// rate) — not a hand-copied number that could silently drift from what
// demo-seed.ts actually seeds, but the same real counts a maintainer
// running `bun run demo` would see.

import { expect, test } from "@playwright/test";
import { getDemoProjectPath, mintFixture } from "../fixtures/fixture-client";

async function openDemoProject(page: import("@playwright/test").Page) {
  const { url } = await mintFixture();
  const demoPath = await getDemoProjectPath();
  await page.goto(url);
  await expect(page.getByLabel("Project folder")).toBeVisible();
  await page.getByLabel("Project folder").fill(demoPath);
  await page.getByRole("button", { name: "Open fern" }).click();
  await expect(page.getByRole("tab", { name: "Fern" })).toBeVisible();
}

test("the demo dataset's stat tiles show the real seeded counts", async ({
  page,
}) => {
  await openDemoProject(page);

  // 2 active fronds (auth-refactor, docker-build) + 1 merged
  // (flaky-test) = 3 total; the "fronds" tile counts active only and
  // notes how many are merged.
  const frondsTile = page.locator(".stat-tile", { hasText: "fronds" });
  await expect(frondsTile.locator(".stat-tile__value")).toHaveText("2");
  await expect(frondsTile.getByText("1 merged")).toBeVisible();

  const straysTile = page.locator(".stat-tile", { hasText: "strays caught" });
  await expect(straysTile.locator(".stat-tile__value")).toHaveText("2");

  // DEMO_UNDO_COUNT (2) undone out of 12 actionable (non-continue)
  // decisions: 3 "new" + 2 "stray" + 5 "return" + 1 "combine" + 1
  // "merge" = 12.
  const undoTile = page.locator(".stat-tile", { hasText: "undo rate" });
  await expect(undoTile.locator(".stat-tile__value")).toHaveText("2 of 12");
});

test("the demo dataset's List view shows every seeded leaflet", async ({
  page,
}) => {
  await openDemoProject(page);
  await page.getByRole("tab", { name: "List" }).click();

  // 17 leaflets: 1 stem continue + 7 under auth-refactor + 5 under
  // docker-build + 2 under flaky-test + 2 strays (recorded off every
  // frond) — the merge action itself records no leaflet.
  await expect(page.locator(".list-view__row")).toHaveCount(17);
  await expect(page.getByText("1–17 of 17")).toBeVisible();

  // demo-seed.ts writes real Recent entries (unlike the plain e2e
  // fixture) — at least one row's prompt column should be real text,
  // not "n/a".
  const prompts = page.locator(".list-view__prompt");
  const promptTexts = await prompts.allTextContents();
  expect(promptTexts.some((t) => t !== "n/a")).toBe(true);
});

test("the demo dataset's Categories view shows a card per frond with real leaflet/stray counts, including the merged one", async ({
  page,
}) => {
  await openDemoProject(page);
  await page.getByRole("tab", { name: "Categories" }).click();

  const cards = page.locator(".categories-view__card");
  await expect(cards).toHaveCount(5); // auth-refactor, docker-build, flaky-test, strays, roots

  await expect(page.getByText("7 leaflets · 1 stray")).toBeVisible();
  await expect(page.getByText("5 leaflets · 1 stray")).toBeVisible();
  await expect(page.getByText("2 leaflets · merged")).toBeVisible();
  await expect(page.getByText("2 caught")).toBeVisible();

  // demo-seed.ts writes a real brief per frond — the card's goal text
  // should be the real synthetic content, not "(no goal recorded yet)".
  await expect(
    page.getByText("Refactor the auth middleware to use short-lived tokens."),
  ).toBeVisible();
});

test("the demo dataset's strays card lists each stray individually, never 'None yet.' next to a real count", async ({
  page,
}) => {
  await openDemoProject(page);
  await page.getByRole("tab", { name: "Categories" }).click();

  const straysCard = page
    .locator(".categories-view__card", { hasText: "2 caught" })
    .first();
  await expect(straysCard).toBeVisible();
  await expect(straysCard.getByText("None yet.")).toHaveCount(0);

  // DEMO_PLAN's two strays (turn 3 from auth-refactor, turn 6 from
  // docker-build — leaflet turns are 0-indexed) never had a Recent
  // entry pushed for their own turn — demo-seed.ts's pushRecentEntry
  // calls are for turns 2/5/10, none of which are strays — so both
  // should honestly read "text not kept", not a fabricated prompt and
  // not silently omitted.
  const items = straysCard.locator(".categories-view__stray-list li");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("turn 3");
  await expect(items.nth(0)).toContainText("auth-refactor");
  await expect(items.nth(0)).toContainText("text not kept");
  await expect(items.nth(1)).toContainText("turn 6");
  await expect(items.nth(1)).toContainText("docker-build");
  await expect(items.nth(1)).toContainText("text not kept");
});
