import { act, render, screen } from "@testing-library/react";
import { QueryClientProvider, focusManager, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_REFRESH_MS, createQueryClient } from "./queryClient";

function Count({ fetcher }: { fetcher: () => Promise<number> }) {
  const q = useQuery({ queryKey: ["n"], queryFn: fetcher });
  return <p>value {q.data ?? "-"}</p>;
}

/** Let the fetch finish and the screen update (a few short timer steps). */
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}

describe("website auto-refresh", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it("re-checks what is on screen every 30 seconds, pauses while the tab is hidden, and refreshes when you come back", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => ++n);
    const qc = createQueryClient();
    render(<QueryClientProvider client={qc}><Count fetcher={fetcher} /></QueryClientProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("value 1")).toBeTruthy();

    // 30 s later: fetched again with no F5.
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_REFRESH_MS); });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByText("value 2")).toBeTruthy();

    // Tab hidden: nothing is fetched for two minutes.
    act(() => focusManager.setFocused(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * AUTO_REFRESH_MS); });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Back on the tab: refreshes right away.
    await act(async () => { focusManager.setFocused(true); });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(screen.getByText("value 3")).toBeTruthy();
    qc.clear();
  });
});
