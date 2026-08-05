import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "./dialog";

// The iOS shell keeps the WKWebView layout viewport full-height when the soft
// keyboard opens, so a modal capped at `85vh` and centered on `50%` would sit
// partly behind the keyboard. DialogContent pins its height cap and centering
// origin to the keyboard-aware `--omnigent-viewport-height` — but only inside
// the iOS shell. These tests pin that gating.

function setIOS(on: boolean): void {
  if (on) {
    (window as unknown as Record<string, unknown>).omnigentNative = { kind: "ios" };
  } else {
    delete (window as unknown as Record<string, unknown>).omnigentNative;
  }
}

afterEach(() => {
  cleanup();
  setIOS(false);
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

function renderDialog() {
  return render(
    <Dialog open onOpenChange={() => {}}>
      <DialogContent>
        <DialogTitle>Test</DialogTitle>
      </DialogContent>
    </Dialog>,
  );
}

describe("DialogContent keyboard-aware sizing", () => {
  it("caps height and centering to the visible viewport inside the iOS shell", () => {
    setIOS(true);
    renderDialog();
    const content = screen.getByRole("dialog");
    // Inline style (not a class) so it wins over any caller's max-h-[85vh].
    expect(content.style.maxHeight).toContain("--omnigent-viewport-height");
    expect(content.style.top).toContain("--omnigent-viewport-height");
  });

  it("applies no viewport inline style off the iOS shell", () => {
    setIOS(false);
    renderDialog();
    const content = screen.getByRole("dialog");
    expect(content.style.maxHeight).toBe("");
    expect(content.style.top).toBe("");
  });
});

describe("DialogContent browser view suppression", () => {
  it("suppresses the native browser for the dialog's mounted lifecycle", () => {
    const suppress = installBrowserBridge();
    const { rerender } = render(
      <Dialog open={false} onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Test dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(suppress).not.toHaveBeenCalled();

    rerender(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Test dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(suppress).toHaveBeenLastCalledWith(true);

    rerender(
      <Dialog open={false} onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Test dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(suppress).toHaveBeenCalledTimes(2);
    expect(suppress).toHaveBeenLastCalledWith(false);
  });

  it("does not restore the browser until the final overlapping dialog closes", () => {
    const suppress = installBrowserBridge();
    const { rerender } = render(
      <>
        <Dialog open onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>First dialog</DialogTitle>
          </DialogContent>
        </Dialog>
        <Dialog open onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>Second dialog</DialogTitle>
          </DialogContent>
        </Dialog>
      </>,
    );
    expect(suppress).toHaveBeenCalledTimes(1);
    expect(suppress).toHaveBeenLastCalledWith(true);

    rerender(
      <>
        <Dialog open={false} onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>First dialog</DialogTitle>
          </DialogContent>
        </Dialog>
        <Dialog open onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>Second dialog</DialogTitle>
          </DialogContent>
        </Dialog>
      </>,
    );
    expect(suppress).toHaveBeenCalledTimes(1);

    rerender(
      <>
        <Dialog open={false} onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>First dialog</DialogTitle>
          </DialogContent>
        </Dialog>
        <Dialog open={false} onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>Second dialog</DialogTitle>
          </DialogContent>
        </Dialog>
      </>,
    );
    expect(suppress).toHaveBeenCalledTimes(2);
    expect(suppress).toHaveBeenLastCalledWith(false);
  });
});
