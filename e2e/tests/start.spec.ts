// Screenshots the Start screen against the real daemon + seeded
// fixture data (see fixtures/run-fixture-daemon.ts and fixtures/seed.ts),
// for manual comparison against docs/design/blueprint/Start.dc.html.

import { expect, test } from "@playwright/test";
import { mintFixture } from "../fixtures/fixture-client";

test("Start screen: heading, recent project, no-account footer, and the character fern art all render", async ({
  page,
}) => {
  const { url, projectName } = await mintFixture();
  await page.goto(url);

  await expect(
    page.getByRole("heading", { name: "Open a fern" }),
  ).toBeVisible();
  // Scoped to the name span specifically — the fixture project's
  // basename is also a substring of its own full path, shown right
  // next to it, so a bare text match is ambiguous between the two.
  await expect(
    page.locator(".start-recent-row__name", { hasText: projectName }),
  ).toBeVisible();
  await expect(page.getByText(/No account needed/)).toBeVisible();
  await expect(
    page.getByText(/Nothing here leaves this machine/),
  ).toBeVisible();
  await expect(page.getByLabel("Project folder")).toBeVisible();

  // The character fern's SVG paths (decorative, aria-hidden) should
  // have real content, not an empty/broken render.
  const artPathCount = await page.locator(".start-card__art svg path").count();
  expect(artPathCount).toBe(3);

  await page.screenshot({
    path: "screenshots/start.png",
    fullPage: true,
  });
});
