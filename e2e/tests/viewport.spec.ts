// Regression coverage for a real bug report: on a real Windows machine
// at common desktop resolutions, the Start screen's card was taller
// than the viewport, so the page itself scrolled vertically — CLAUDE.md
// and the design both call for a fixed, viewport-filling shell with
// internal panel scrolling only, never a page-level scrollbar. Checks
// the real, observable symptom (document.documentElement.scrollHeight
// vs. window.innerHeight) rather than any particular CSS property, at
// both a common laptop size and a common desktop size.

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { mintFixture } from "../fixtures/fixture-client";

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];

// A string expression, not a typed function body — this repo's e2e
// tsconfig has no "dom" lib (nothing else here runs in a browser
// context), so `document`/`window` as real TS identifiers would fail
// to compile; Playwright evaluates a string in the page exactly the
// same way, with no such requirement on this side.
function hasNoPageScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    "document.documentElement.scrollHeight <= window.innerHeight",
  );
}

for (const viewport of VIEWPORTS) {
  test(`Start screen has no page-level vertical scroll at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const { url } = await mintFixture();
    await page.goto(url);
    await expect(
      page.getByRole("heading", { name: "Open a fern" }),
    ).toBeVisible();

    expect(await hasNoPageScroll(page)).toBe(true);
  });

  test(`the app shell has no page-level vertical scroll at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const { url, projectName } = await mintFixture();
    await page.goto(url);
    await page
      .locator(".start-recent-row__name", { hasText: projectName })
      .click();
    await expect(page.getByRole("tab", { name: "Fern" })).toBeVisible();
    await expect(page.locator(".frond-legend__row")).toHaveCount(5);

    expect(await hasNoPageScroll(page)).toBe(true);
  });

  // Regression for a real bug: .app-shell__body's CSS grid had no
  // explicit row track, so its single implicit row sized to its
  // tallest child's own content height instead of the grid's definite
  // height — fern-view and inspector then overflowed their row and
  // visually overlapped the stat tiles row below (a stray "c" from
  // "off-topic" peeking out at the undo-rate tile's left edge). A
  // no-page-scroll check alone doesn't catch this — the page's overall
  // height can still be exactly right while content inside it overlaps.
  // This asserts the real, observable symptom: every stat tile fully
  // visible, with no panel's bottom edge extending past the stats row's
  // own top edge, on a populated fixture (not an empty session, where
  // a shorter inspector card wouldn't have overflowed in the first place).
  test(`the Fern view's four stat tiles are fully visible with no panel overlapping them at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const { url, projectName } = await mintFixture();
    await page.goto(url);
    await page
      .locator(".start-recent-row__name", { hasText: projectName })
      .click();
    await expect(page.getByRole("tab", { name: "Fern" })).toBeVisible();
    await expect(page.locator(".frond-legend__row")).toHaveCount(5);

    const tiles = page.locator(".stat-tile");
    await expect(tiles).toHaveCount(4);
    for (const tile of await tiles.all()) {
      await expect(tile).toBeVisible();
    }

    const statsBox = await page.locator(".app-shell__stats").boundingBox();
    const fernViewBox = await page.locator(".fern-view").boundingBox();
    const inspectorBox = await page.locator(".inspector").boundingBox();
    expect(statsBox).not.toBeNull();
    expect(fernViewBox).not.toBeNull();
    expect(inspectorBox).not.toBeNull();
    if (statsBox && fernViewBox && inspectorBox) {
      expect(fernViewBox.y + fernViewBox.height).toBeLessThanOrEqual(
        statsBox.y,
      );
      expect(inspectorBox.y + inspectorBox.height).toBeLessThanOrEqual(
        statsBox.y,
      );
    }
  });
}
