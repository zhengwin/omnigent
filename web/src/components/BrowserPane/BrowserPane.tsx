/** Embedded browser pane (Phase 2).
 *
 *  Ported from SP2K `frontend/src/components/BrowserPreview/BrowserPreviewPanel.tsx`
 *  (the bounds-sync half). The actual web page is a native Electron
 *  WebContentsView positioned by the main process; the React side renders ONLY
 *  a placeholder `<div>` that MEASURES its own rect with getBoundingClientRect()
 *  and pushes those bounds over IPC so the main process can lay the native view
 *  on top of the placeholder pixel-for-pixel.
 *
 *  Why a native overlay instead of a webview/iframe: the agent needs to drive a
 *  real Chromium page (screenshot, execute relay JS, cross-origin navigation)
 *  which an iframe can't provide, and Electron's `<webview>` is deprecated.
 *
 *  Two responsibilities, deliberately kept in one mounted component:
 *   1. Always keep the agent relay (`useBrowserAgentRelay`) alive for the
 *      conversation — the FIRST `browser_navigate` action is what creates the
 *      view, so the relay must be listening before any view exists.
 *   2. Once a view IS attached for this conversation, render a measuring
 *      placeholder that occupies layout space and keeps the native view
 *      positioned over it. Before that, render nothing (zero layout footprint)
 *      so an idle conversation's chat isn't split in half by an empty pane.
 *
 *  DETACH-not-destroy on unmount: the view keeps running (a background agent's
 *  page survives a pane switch); it is destroyed only on explicit close.
 *
 *  Gated on `isElectronShell()` — in a plain browser this renders nothing and
 *  the relay is a no-op (there is no native view to position). */
import { useCallback, useEffect, useRef, useState } from "react";
import { isElectronShell } from "@/lib/nativeBridge";
import { useBrowserAgentRelay } from "@/hooks/useBrowserAgentRelay";

/** Renderer CSS-pixel bounds pushed to the main process (converted to window
 *  DIPs there via the host zoom factor). */
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
  devicePixelRatio?: number;
}

/** Subset of `window.omnigentDesktop` the pane calls. Typed locally so the
 *  component doesn't depend on the full nativeBridge type; every method is
 *  optional (an older shell may predate the browser feature). */
interface BrowserPaneBridge {
  browserSetActive?: (
    conversationId: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  browserResize?: (
    conversationId: string,
    bounds: Bounds,
  ) => Promise<{ ok: boolean; error?: string }>;
  onBrowserHostActiveChanged?: (
    callback: (payload: { conversationId: string | null }) => void,
  ) => () => void;
  onBrowserViewClosed?: (
    callback: (payload: { conversationId: string; reason: string | null }) => void,
  ) => () => void;
}

function getBridge(): BrowserPaneBridge | null {
  if (!isElectronShell()) return null;
  const w = window as unknown as { omnigentDesktop?: BrowserPaneBridge };
  return w.omnigentDesktop ?? null;
}

export interface BrowserPaneProps {
  /** Conversation whose WebContentsView this pane hosts. */
  conversationId: string;
  /** Extra classes for the measuring placeholder wrapper. */
  className?: string;
}

/**
 * Keeps the agent relay alive for a conversation and, once a native browser
 * view is attached, keeps that view positioned over a measuring placeholder.
 */
export function BrowserPane({ conversationId, className }: BrowserPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastBoundsRef = useRef<Bounds | null>(null);
  const electron = isElectronShell();
  // Whether a native view is currently attached for THIS conversation. Driven
  // by the registry's host-active-changed / view-closed pings, so the
  // placeholder appears exactly when there's a view to position and disappears
  // the moment it's closed — no empty pane on an idle conversation.
  const [viewActive, setViewActive] = useState(false);

  // Mount the relay for this conversation (no-op outside Electron). Always live
  // — the first browser_navigate creates the view, so the relay must be
  // listening before `viewActive` ever flips true.
  useBrowserAgentRelay(conversationId);

  // Track attach/detach + close so the placeholder mounts only when a view
  // exists for this conversation.
  useEffect(() => {
    if (!electron) return;
    const bridge = getBridge();
    if (!bridge) return;
    const unsubActive = bridge.onBrowserHostActiveChanged?.((payload) => {
      setViewActive(payload.conversationId === conversationId);
    });
    const unsubClosed = bridge.onBrowserViewClosed?.((payload) => {
      if (payload.conversationId === conversationId) setViewActive(false);
    });
    return () => {
      unsubActive?.();
      unsubClosed?.();
    };
  }, [conversationId, electron]);

  // Measure the placeholder and push bounds to the main process. These are
  // renderer CSS pixels; the main process converts to WebContentsView DIPs
  // using the host zoom factor (they diverge after Cmd+/Cmd- zoom).
  const syncBounds = useCallback(
    (force = false) => {
      const bridge = getBridge();
      if (!containerRef.current || !bridge?.browserResize) return;
      const rect = containerRef.current.getBoundingClientRect();
      const bounds: Bounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        devicePixelRatio: window.devicePixelRatio,
      };
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const last = lastBoundsRef.current;
      if (
        !force &&
        last &&
        last.x === bounds.x &&
        last.y === bounds.y &&
        last.width === bounds.width &&
        last.height === bounds.height &&
        last.devicePixelRatio === bounds.devicePixelRatio
      ) {
        return;
      }
      lastBoundsRef.current = bounds;
      void bridge.browserResize(conversationId, bounds);
    },
    [conversationId],
  );

  // Attach this conversation's view to the host window when the placeholder is
  // present; DETACH (not destroy) on unmount so a background agent's page keeps
  // running when the user switches away. A later mount re-attaches.
  useEffect(() => {
    if (!electron || !viewActive) return;
    const bridge = getBridge();
    if (!bridge?.browserSetActive) return;
    void bridge.browserSetActive(conversationId);
    // Measure after a couple of frames so any pane-open transition settles
    // before the first bounds land (the rAF loop below corrects stragglers).
    let frame = 0;
    let cancelled = false;
    const measureSoon = () => {
      if (cancelled) return;
      if (frame++ < 5) {
        requestAnimationFrame(measureSoon);
        return;
      }
      syncBounds(true);
    };
    requestAnimationFrame(measureSoon);
    return () => {
      cancelled = true;
      lastBoundsRef.current = null;
      // Detach whatever is currently active (this pane owned it). The view
      // survives in the registry; only an explicit close destroys it.
      try {
        void getBridge()?.browserSetActive?.(null);
      } catch {
        /* swallow — window may be tearing down */
      }
    };
  }, [conversationId, electron, viewActive, syncBounds]);

  // Reconcile bounds every animation frame while a view is shown. setBounds
  // with the same rect is a no-op in Electron native, and we dedupe in JS via
  // lastBoundsRef, so this is cheap. It catches every layout shift —
  // ResizeObserver only fires on SIZE changes, so position-only shifts (sibling
  // pane resize, ancestor scroll) would otherwise strand the native overlay.
  //
  // Wrapped in try/catch: if syncBounds ever throws (bridge rejects
  // synchronously during a teardown window) we MUST still schedule the next
  // frame, or the rAF chain dies silently and the overlay floats stranded.
  useEffect(() => {
    if (!electron || !viewActive) return;
    let rafId = 0;
    const tick = () => {
      try {
        syncBounds();
      } catch (e) {
        console.warn("[BrowserPane] syncBounds threw:", e);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [electron, viewActive, syncBounds]);

  // Defense-in-depth against a hung rAF chain: ResizeObserver fires on size
  // changes (pane splits / window resizes), `window.resize` on every Electron
  // resize event, and `visibilitychange` covers tab-back-from-background where
  // rAFs were throttled. Each alone is enough to recover on the next
  // user-visible interaction.
  useEffect(() => {
    if (!electron || !viewActive || !containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(() => syncBounds());
    ro.observe(el);
    const onResize = () => syncBounds();
    const onVisibility = () => {
      if (document.visibilityState === "visible") syncBounds();
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [electron, viewActive, syncBounds]);

  // Plain browser, or no view yet: render nothing (zero layout footprint). The
  // relay above is still live so the first navigate can create the view.
  if (!electron || !viewActive) return null;

  // The placeholder only MEASURES — the native WebContentsView paints over it.
  return (
    <div
      ref={containerRef}
      className={className}
      data-browser-pane-conversation={conversationId}
      style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}
    />
  );
}
