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
 *   2. In the Electron shell the pane is ALWAYS visible and occupies its half of
 *      the row. Before a view is attached (`viewActive` false) it shows a
 *      centered empty state; once a view IS attached it renders the measuring
 *      placeholder the native WebContentsView paints over. The bounds-sync
 *      machinery (containerRef + syncBounds + rAF/ResizeObserver effects) is
 *      gated on `viewActive`, so nothing measures an empty-state div.
 *
 *  DETACH-not-destroy on unmount: the view keeps running (a background agent's
 *  page survives a pane switch); it is destroyed only on explicit close.
 *
 *  Gated on `isElectronShell()` — in a plain browser this renders nothing (no
 *  empty split pane in the web build) and the relay is a no-op. */
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
  onBrowserViewCreated?: (
    callback: (payload: { conversationId: string }) => void,
  ) => () => void;
  onBrowserViewClosed?: (
    callback: (payload: { conversationId: string; reason: string | null }) => void,
  ) => () => void;
  browserHasView?: (conversationId: string) => Promise<{ exists: boolean }>;
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

  // Decide when a view EXISTS for this conversation, so the placeholder mounts
  // exactly then. Three signals feed `viewActive`:
  //   1. `browser-view-created` — the FIRST navigate creates the view (often
  //      detached, so no host-active event fires); this is the signal that
  //      breaks the original activation deadlock.
  //   2. `browserHasView` probe on (re)mount — the user navigated away and
  //      back, and the view already exists in the registry.
  //   3. `browser-host-active-changed` — a later attach/detach for this
  //      conversation keeps the flag honest (detach for another conversation
  //      flips it false).
  // `browser-view-closed` for this conversation flips it false.
  useEffect(() => {
    if (!electron) return;
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;

    // (2) Re-show an already-created view when the pane remounts.
    void bridge.browserHasView?.(conversationId).then((r) => {
      if (!cancelled && r?.exists) setViewActive(true);
    });

    // (1) A view was just created for this conversation (first navigate).
    const unsubCreated = bridge.onBrowserViewCreated?.((payload) => {
      if (payload.conversationId === conversationId) setViewActive(true);
    });
    // (3) Attach/detach transitions. An attach for another conversation, or a
    // detach (null), means this pane's view is no longer the visible one.
    const unsubActive = bridge.onBrowserHostActiveChanged?.((payload) => {
      if (payload.conversationId === conversationId) setViewActive(true);
      else if (payload.conversationId === null) setViewActive(false);
    });
    const unsubClosed = bridge.onBrowserViewClosed?.((payload) => {
      if (payload.conversationId === conversationId) setViewActive(false);
    });
    return () => {
      cancelled = true;
      unsubCreated?.();
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

  // Plain browser (non-Electron): render nothing so the web build has no empty
  // split pane. The relay is a no-op there anyway.
  if (!electron) return null;

  // In the Electron shell the pane ALWAYS occupies its half of the row. Two
  // inner states:
  //   - viewActive: the measuring placeholder — the native WebContentsView
  //     paints over it. `containerRef` + syncBounds + the rAF/observer effects
  //     (all gated on viewActive above) keep it positioned.
  //   - !viewActive: a centered empty state. NO containerRef here, so no bounds
  //     are measured off an empty div; the effects stay dormant until the first
  //     browser-view-created / host-active signal flips viewActive true.
  return (
    <div
      className={className}
      data-browser-pane-conversation={conversationId}
      style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}
    >
      {viewActive ? (
        // The placeholder only MEASURES — the native WebContentsView paints
        // over it. Fills the wrapper so its rect equals the pane's rect.
        <div
          ref={containerRef}
          style={{ position: "absolute", inset: 0, minWidth: 0, minHeight: 0 }}
        />
      ) : (
        <div className="flex h-full flex-1 items-center justify-center bg-card px-6 py-8 text-center text-muted-foreground text-sm">
          No page open — the agent will open pages here, or navigate to get
          started.
        </div>
      )}
    </div>
  );
}
