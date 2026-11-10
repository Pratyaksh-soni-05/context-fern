// Screenshots the Categories view against the real daemon + seeded
// fixture data, after navigating through the real Start -> open flow,
// for manual comparison against docs/design/blueprint/Prototype.dc.html.

import { expect, test } from "@playwright/test";
import { mintFixture } from "../fixtures/fixture-client";

test("Categories view: a card per frond (including a merged one), a strays card with a real caught prompt, a genuinely-empty roots card, and the heatmap", async ({
  page,
}) => {
  const { url, projectName } = await mintFixture();
  await page.goto(url);
  await page
    .locator(".start-recent-row__name", { hasText: projectName })
    .click();

  await expect(page.getByRole("tab", { name: "Categories" })).toBeVisible();
  await page.getByRole("tab", { name: "Categories" }).click();

  const cards = page.locator(".categories-view__card");
  // auth-refactor, docker-build, flaky-test (merged — still a card here,
  // unlike the sidebar legend which hides merged fronds), strays, roots.
  await expect(cards).toHaveCount(5);

  await expect(page.getByText("4 leaflets · 1 stray")).toBeVisible();
  await expect(page.getByText("3 leaflets · 1 stray")).toBeVisible();
  await expect(page.getByText("2 leaflets · merged")).toBeVisible();

  await expect(
    page.getByText("Off-topic questions, kept off every frond"),
  ).toBeVisible();
  await expect(page.getByText("2 caught")).toBeVisible();

  // Nothing writes a Root row yet — the roots card is a real, honest
  // zero, not a placeholder (spec §15).
  await expect(page.getByText("Memories from earlier sessions")).toBeVisible();
  await expect(page.getByText("0 used")).toBeVisible();

  await expect(
    page.getByText("topic switching over the session"),
  ).toBeVisible();
  await expect(page.getByText(/turns? per cell/)).toBeVisible();
  await expect(page.locator(".categories-view__heatmap-row")).toHaveCount(5); // stem + 3 fronds + stray

  await page.screenshot({
    path: "screenshots/categories-view.png",
    fullPage: true,
  });
});

test("clicking the strays card selects it and the inspector shows real stray turns", async ({
  page,
}) => {
  const { url, projectName } = await mintFixture();
  await page.goto(url);
  await page
    .locator(".start-recent-row__name", { hasText: projectName })
    .click();
  await expect(page.getByRole("tab", { name: "Categories" })).toBeVisible();
  await page.getByRole("tab", { name: "Categories" }).click();

  await page.getByText("Off-topic questions, kept off every frond").click();

  await expect(page.getByText("strays · off-topic")).toBeVisible();
});
