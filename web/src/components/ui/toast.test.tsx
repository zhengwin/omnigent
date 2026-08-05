// Unit tests for the minimal toast system: showToast() renders content into a
// mounted <Toaster />, and the dismiss control removes it.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showToast, Toaster } from "./toast";

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).omnigentDesktop;
});

function installBrowserBridge() {
  const browserSetOverlaySuppressed = vi.fn().mockResolvedValue({ ok: true });
  (window as unknown as Record<string, unknown>).omnigentDesktop = {
    kind: "electron",
    browserOpenOrNavigate: vi.fn(),
    browserSetOverlaySuppressed,
  };
  return browserSetOverlaySuppressed;
}

describe("Toaster", () => {
  it("renders nothing until a toast is shown", () => {
    render(<Toaster />);
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("shows toast content and dismisses on the close button", () => {
    render(<Toaster />);
    act(() => showToast(<span>Hello there</span>, { duration: 0 }));

    const toast = screen.getByTestId("toast");
    expect(toast).toHaveTextContent("Hello there");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("suppresses the native browser while a toast is active", () => {
    const suppress = installBrowserBridge();
    render(<Toaster />);
    expect(suppress).not.toHaveBeenCalled();

    act(() => showToast(<span>Hello there</span>, { duration: 0 }));
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(suppress).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(suppress).toHaveBeenCalledTimes(2);
    expect(suppress).toHaveBeenLastCalledWith(false);
  });

  it("keeps the browser suppressed until the final toast is dismissed", () => {
    const suppress = installBrowserBridge();
    render(<Toaster />);

    act(() => {
      showToast(<span>First</span>, { duration: 0 });
      showToast(<span>Second</span>, { duration: 0 });
    });
    expect(screen.getAllByTestId("toast")).toHaveLength(2);
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(suppress).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
    expect(screen.getAllByTestId("toast")).toHaveLength(1);
    expect(suppress).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(suppress).toHaveBeenCalledTimes(2);
    expect(suppress).toHaveBeenLastCalledWith(false);
  });
});
