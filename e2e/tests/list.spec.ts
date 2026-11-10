// Screenshots the List view against the real daemon + seeded fixture
// data, after navigating through the real Start -> open flow, for
// manual comparison against docs/design/blueprint/Prototype.dc.html.

import { expect, test } from "@playwright/test";
import { mintFixture } from "../fixtures/fixture-client";

test("List view: every seeded leaflet renders as a row with real turn, frond, kind, and confidence", async ({
  page,
}) => {
  const { url, projectName } = await mintFixture();
  await page.goto(url);
  await page
    .locator(".start-recent-row__name", { hasText: projectName })
    .click();

  await expect(page.getByRole("tab", { name: "List" })).toBeVisible();
  await page.getByRole("tab", { name: "List" }).click();

  const header = page.locator(".list-view__header");
  await expect(header.getByText("turn")).toBeVisible();
  await expect(header.getByText("frond")).toBeVisible();
  await expect(header.getByText("kind")).toBeVisible();
  await expect(header.getByText("prompt")).toBeVisible();
  await expect(header.getByText("context")).toBeVisible();
  await expect(header.getByText("conf")).toBeVisible();

  // The fixture's 13-turn plan yields 12 leaflets (one turn is a merge,
  // which records no leaflet of its own) — every one of them should be
  // a reachable row, not just the ones that fit the Fern graph's cap.
  const rows = page.locator(".list-view__row");
  await expect(rows).toHaveCount(12);

  await expect(page.getByText("auth-refactor").first()).toBeVisible();
  await expect(page.getByText("docker-build").first()).toBeVisible();
  await expect(page.getByText("stray ← auth-refactor")).toBeVisible();
  await expect(page.getByText("1–12 of 12")).toBeVisible();

  // No `pushRecentEntry` call in this fixture's seed path — every
  // row's prompt cell is honestly "n/a", not a fabricated string.
  await expect(page.locator(".list-view__prompt").first()).toHaveText("n/a");

  await page.screenshot({ path: "screenshots/list-view.png", fullPage: true });
});

test("clicking a List row selects that leaflet and updates the inspector", async ({
  page,
}) => {
  const { url, projectName } = await mintFixture();
  await page.goto(url);
  await page
    .locator(".start-recent-row__name", { hasText: projectName })
    .click();
  await expect(page.getByRole("tab", { name: "List" })).toBeVisible();
  await page.getByRole("tab", { name: "List" }).click();

  const firstRow = page.locator(".list-view__row").first();
  await expect(firstRow).toBeVisible();
  await firstRow.click();

  await expect(firstRow).toHaveAttribute("data-selected", "true");
});
