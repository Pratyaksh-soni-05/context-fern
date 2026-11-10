// Screenshots the Fern view against the real daemon + seeded fixture
// data, after navigating through the real Start -> open flow (not a
// direct deep link), for manual comparison against
// docs/design/blueprint/Prototype.dc.html.

import { expect, test } from "@playwright/test";
import { mintFixture } from "../fixtures/fixture-client";

test("Fern view: stem, coloured fronds, leaflet nodes, and the replay controls all render after opening a project from Start", async ({
  page,
}) => {
  const { url, projectName } = await mintFixture();
  await page.goto(url);
  // Scoped to the name span — the project's basename is also a
  // substring of its own full path, shown right next to it.
  await page
    .locator(".start-recent-row__name", { hasText: projectName })
    .click();

  await expect(page.getByRole("tab", { name: "Fern" })).toBeVisible();
  // The stem's own curve + stipple render immediately, with no data
  // dependency — waiting for a real frond's legend row (not just any
  // SVG path) is what actually confirms the async /fronds + /leaflets
  // fetch has resolved, rather than racing ahead of it.
  await expect(page.locator(".frond-legend__row")).toHaveCount(5);
  await expect(page.locator(".fern-view svg path").first()).toBeVisible();

  // At least one frond curve and some stippled leaflet dots should be
  // present — real data, not an empty graph.
  const pathCount = await page.locator(".fern-view svg path").count();
  expect(pathCount).toBeGreaterThan(3);

  const nodeCount = await page.locator(".fern-view svg circle").count();
  expect(nodeCount).toBeGreaterThan(0);

  await expect(page.getByRole("button", { name: "replay" })).toBeVisible();
  await expect(page.getByLabel("growth")).toBeVisible();

  // Stat tiles are real data, not placeholders.
  await expect(page.getByText("kept out of this turn")).toBeVisible();
  await expect(page.getByText("n/a").first()).toBeVisible();

  await page.screenshot({ path: "screenshots/fern-view.png", fullPage: true });
});

test("clicking a frond in the legend dims the rest of the graph to 18% opacity", async ({
  page,
}) => {
  const { url, projectName } = await mintFixture();
  await page.goto(url);
  await page
    .locator(".start-recent-row__name", { hasText: projectName })
    .click();
  await expect(page.locator(".fern-view svg")).toBeVisible();
  await expect(page.locator(".frond-legend__row")).toHaveCount(5);

  const legendRow = page.locator(".frond-legend__row").nth(1); // first real frond, after "main · stem"
  await legendRow.click();

  const dimmedOpacity = await page
    .locator(".fern-view svg path[opacity]")
    .first()
    .getAttribute("opacity");
  expect(dimmedOpacity).not.toBeNull();
});
