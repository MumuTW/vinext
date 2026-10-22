import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const TARGET_PREFIX = "/prefetch-queue-viewport/";

/** Resolves once every queued link is out of (or back in) the prefetch range. */
function waitForLinksIntersecting(page: Page, intersecting: boolean): Promise<void> {
  return page.evaluate(
    (expected) =>
      new Promise<void>((resolve) => {
        const links = [...document.querySelectorAll(".queued-link")];
        const state = new Map<Element, boolean>();
        // Same rootMargin as Link's observer. Observers are notified in creation
        // order, so Link's has already seen the change when this one resolves.
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) state.set(entry.target, entry.isIntersecting);
            if (links.every((link) => state.get(link) === expected)) {
              observer.disconnect();
              resolve();
            }
          },
          { rootMargin: "250px" },
        );
        for (const link of links) observer.observe(link);
      }),
    intersecting,
  );
}

// Next.js cancels a Link's queued prefetch when the Link leaves the viewport
// and schedules it again when the Link comes back. Requests already in flight
// still finish.
test("drops queued Link prefetches that left the viewport and retries them on return", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const heldTargets = new Set<string>();
  const requestedTargets: string[] = [];
  let scrolledAway = false;
  const requestedWhileAway: string[] = [];

  await page.route("**/*", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.headers()["next-router-prefetch"] !== "1" || !pathname.startsWith(TARGET_PREFIX)) {
      return route.continue();
    }
    const target = pathname.slice(TARGET_PREFIX.length).replace(/\.rsc$/, "");
    requestedTargets.push(target);
    if (scrolledAway) requestedWhileAway.push(target);
    if (heldTargets.size < 4) {
      // Occupy the four prefetch slots so the other links' prefetches queue.
      heldTargets.add(target);
      const response = await route.fetch();
      await held;
      return route.fulfill({ response });
    }
    return route.continue();
  });

  try {
    await page.goto("/prefetch-queue-viewport");
    await waitForAppRouterHydration(page);
    await expect.poll(() => heldTargets.size).toBe(4);
    // Count the pending prefetches and keep a barrier for all of them.
    const pendingPrefetches = () =>
      page.evaluate(() => {
        const state = window as unknown as {
          __VINEXT_RSC_PREFETCH_CACHE__?: Map<string, { pending?: Promise<unknown> }>;
          __queuedPrefetches?: Promise<unknown>;
        };
        const pending = new Set(
          [...(state.__VINEXT_RSC_PREFETCH_CACHE__?.values() ?? [])].flatMap((entry) =>
            entry.pending ? [entry.pending] : [],
          ),
        );
        state.__queuedPrefetches = Promise.allSettled(pending);
        return pending.size;
      });
    await expect.poll(pendingPrefetches).toBeGreaterThanOrEqual(8);

    scrolledAway = true;
    await page.locator("#bottom").scrollIntoViewIfNeeded();
    await waitForLinksIntersecting(page, false);
    releaseHeld();
    await page.evaluate(
      () => (window as unknown as { __queuedPrefetches: Promise<unknown> }).__queuedPrefetches,
    );
    expect(requestedWhileAway).toEqual([]);

    await page.evaluate(() => window.scrollTo(0, 0));
    await waitForLinksIntersecting(page, true);
    await expect.poll(() => new Set(requestedTargets).size).toBe(8);
    // Only the queued links are requested again; the held ones were cached.
    for (const target of heldTargets) {
      expect(requestedTargets.filter((requested) => requested === target)).toHaveLength(1);
    }

    const queuedTarget = ["1", "2", "3", "4", "5", "6", "7", "8"].find(
      (target) => !heldTargets.has(target),
    );
    await page.getByRole("link", { name: `Target ${queuedTarget}`, exact: true }).click();
    await expect(page.getByRole("heading", { name: `Target ${queuedTarget}` })).toBeVisible();
  } finally {
    releaseHeld();
    await page.unrouteAll({ behavior: "wait" });
  }
});
