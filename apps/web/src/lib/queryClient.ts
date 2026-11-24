import { QueryClient } from "@tanstack/react-query";

/**
 * How often the website re-checks what's on screen, so photos, issues, comments and
 * alerts added from a phone show up without pressing F5 (JB, 2026-11-24).
 *
 * Kept light on purpose:
 * - Only the lists showing on the current page are re-fetched (react-query skips
 *   anything not on screen). Photo files themselves are never re-downloaded.
 * - Nothing is re-fetched while the tab is hidden or minimized.
 * - Coming back to the tab refreshes right away (if the data is older than 30 s).
 */
export const AUTO_REFRESH_MS = 30_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: AUTO_REFRESH_MS,
        refetchInterval: AUTO_REFRESH_MS,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
      },
    },
  });
}
