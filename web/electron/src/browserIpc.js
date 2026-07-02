// IPC surface for the embedded browser pane (Phase 2), extracted out of main.js
// to keep that file from growing without bound. main.js wires the per-window
// registry + trust gate and calls `registerBrowserIpc(...)` once.
//
// Every handler is gated on `isPinnedOriginSender` — only the trusted server's
// own page may drive the browser views — and resolves the sender window's own
// registry, so one window can never manipulate another's panes. This is a
// load-bearing trust boundary (Risk-2): do NOT drop the gate from any handler,
// including the toolbar ones (navigate / back / forward / reload / devtools).
//
// The channel names mirror the preload bridge (`omnigent:browser-*`):
//   open-or-navigate, set-active, resize, screenshot, execute, has-view, close,
//   go-back, go-forward, reload, open-devtools.
// Renderer-bound events (main → SPA): browser-url-changed, browser-nav-state
// (plus browser-view-created / -host-active-changed / -view-closed from the
// registry itself).

"use strict";

/**
 * Read the current back/forward availability off a webContents. Electron 42
 * moved these onto `webContents.navigationHistory`; the older top-level
 * `canGoBack()` / `canGoForward()` are deprecated. Prefer the new API and fall
 * back so this keeps working across Electron versions. Never throws.
 *
 * @param {Electron.WebContents} wc
 * @returns {{ canGoBack: boolean, canGoForward: boolean }}
 */
function readNavState(wc) {
  try {
    const nav = wc.navigationHistory;
    if (nav && typeof nav.canGoBack === "function") {
      return { canGoBack: !!nav.canGoBack(), canGoForward: !!nav.canGoForward() };
    }
    if (typeof wc.canGoBack === "function") {
      return { canGoBack: !!wc.canGoBack(), canGoForward: !!wc.canGoForward() };
    }
  } catch {
    /* destroyed / mid-teardown */
  }
  return { canGoBack: false, canGoForward: false };
}

/** Navigate back through history, preferring the Electron 42 navigationHistory
 *  API. Returns true if a back navigation was issued. Never throws. */
function goBack(wc) {
  try {
    const nav = wc.navigationHistory;
    if (nav && typeof nav.canGoBack === "function") {
      if (nav.canGoBack()) {
        nav.goBack();
        return true;
      }
      return false;
    }
    if (typeof wc.canGoBack === "function" && wc.canGoBack()) {
      wc.goBack();
      return true;
    }
  } catch {
    /* destroyed */
  }
  return false;
}

/** Navigate forward through history. Returns true if issued. Never throws. */
function goForward(wc) {
  try {
    const nav = wc.navigationHistory;
    if (nav && typeof nav.canGoForward === "function") {
      if (nav.canGoForward()) {
        nav.goForward();
        return true;
      }
      return false;
    }
    if (typeof wc.canGoForward === "function" && wc.canGoForward()) {
      wc.goForward();
      return true;
    }
  } catch {
    /* destroyed */
  }
  return false;
}

/**
 * Wire main-process navigation listeners onto a freshly-created view so the
 * toolbar's URL bar can live-track the REAL url (redirects, in-page link
 * clicks, agent navigation) instead of going stale like SP2K's bar does. Fires
 * `browser-url-changed` and `browser-nav-state` to the renderer that owns the
 * view. Attached once, at create time; the webContents outlives the listeners
 * (they die with the view).
 *
 * @param {object} params
 * @param {string} params.conversationId
 * @param {Electron.WebContents} params.webContents
 * @param {(channel: string, payload: unknown) => void} params.send  window-scoped sender
 */
function attachNavListeners({ conversationId, webContents, send }) {
  const emitUrl = (url) => {
    send("browser-url-changed", { conversationId, url });
    const { canGoBack, canGoForward } = readNavState(webContents);
    send("browser-nav-state", { conversationId, canGoBack, canGoForward });
  };
  // Full main-frame navigation (loadURL, redirects, back/forward, reload).
  webContents.on("did-navigate", (_e, url) => emitUrl(url));
  // SPA route changes / hash links / history.pushState within the same doc.
  webContents.on("did-navigate-in-page", (_e, url, isMainFrame) => {
    if (isMainFrame) emitUrl(url);
  });
}

// ── Design mode (point-and-prompt) ─────────────────────────────────────────
// A toolbar toggle injects an in-page picker into the WebContentsView: hover
// highlights the element under the cursor; click opens an anchored popup
// (input + Send) on that element; Send routes a prompt describing the element
// (+ a cropped screenshot) to the agent through the NORMAL chat send path (see
// AppShell's element-prompt-submit listener). A green/red result is painted
// back into the popup.
//
// Ported near-verbatim from SP2K `electron/main.js` (DESIGN_MODE_SCRIPT +
// makeDesignModeConsoleHandler), renaming markers `__sp2k_*` → `__omni_*` and
// `window.__sp2kDesignMode` → `window.__omniDesignMode`. Unlike SP2K there is
// NO backend route: the element prompt is an ordinary user message, so this is
// a pure client affordance (no server flag, no AP route, no schema/event).
//
// The injected script can't `require('electron')`, so it talks back to the
// main process over `console.log` markers, which the per-entry console-message
// listener below forwards to the owning renderer via `send(...)`:
//   __omni_element_select__<json>         element clicked, popup shown
//   __omni_element_prompt_submit__<json>  user pressed Send / Enter
//   __omni_element_dismiss__              user pressed × / Escape

/**
 * Per-conversation design-mode console listener. Bound to its own webContents
 * and conversationId + window-scoped `send`, so a late marker from an inactive
 * conversation is delivered tagged with its own conversationId and can't mutate
 * another's state. Stored on the registry entry (`entry.designModeListener` /
 * `entry.designModeWebContents`) so the registry's `close()` detaches it.
 *
 * @param {string} conversationId
 * @param {object} entry  registry entry (holds `.view`)
 * @param {(channel: string, payload: unknown) => void} send  window-scoped sender
 * @returns {(event: unknown, level: unknown, message: unknown) => void}
 */
function makeDesignModeConsoleHandler(conversationId, entry, send) {
  return (_event, _level, message) => {
    // The webContents may be destroyed mid-callback during teardown; bail
    // rather than fire against a dead object.
    if (!entry || !entry.view || entry.view.webContents.isDestroyed?.()) return;
    if (typeof message !== "string") return;
    if (message.startsWith("__omni_element_select__")) {
      (async () => {
        try {
          const info = JSON.parse(message.slice("__omni_element_select__".length));
          let screenshotDataUrl = null;
          if (info.rect && info.rect.width > 0 && info.rect.height > 0) {
            const dpr = entry.view.webContents.getZoomFactor() || 1;
            const image = await entry.view.webContents.capturePage({
              x: Math.round(info.rect.x * dpr),
              y: Math.round(info.rect.y * dpr),
              width: Math.round(info.rect.width * dpr),
              height: Math.round(info.rect.height * dpr),
            });
            screenshotDataUrl = "data:image/png;base64," + image.toPNG().toString("base64");
          }
          send("browser-element-selected", { conversationId, ...info, screenshot: screenshotDataUrl });
        } catch (e) {
          console.error("[design-mode]", e);
        }
      })();
      return;
    }
    if (message.startsWith("__omni_element_prompt_submit__")) {
      try {
        const payload = JSON.parse(message.slice("__omni_element_prompt_submit__".length));
        send("browser-element-prompt-submit", { conversationId, ...payload });
      } catch (e) {
        console.error("[design-mode]", e);
      }
      return;
    }
    if (message === "__omni_element_dismiss__") {
      send("browser-element-prompt-dismiss", { conversationId });
    }
  };
}

// In-page design-mode driver injected via `executeJavaScript`. Hover overlay +
// tag/component label, plus an anchored popup (input + Send) hosted inside the
// page DOM (Electron's WebContentsView paints natively over its rect, so a
// React-layer popup inside that rect would be hidden). Ported from SP2K.
const DESIGN_MODE_SCRIPT = `
(function() {
  if (window.__omniDesignMode) return;
  window.__omniDesignMode = true;

  const overlay = document.createElement('div');
  overlay.id = '__omni-highlight';
  overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #c15f3c;background:rgba(193,95,60,0.08);transition:all 0.1s ease;display:none;';
  document.body.appendChild(overlay);
  const label = document.createElement('div');
  label.id = '__omni-label';
  label.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;background:#c15f3c;color:#fff;font:11px/1.4 -apple-system,sans-serif;padding:2px 6px;border-radius:3px;display:none;white-space:nowrap;';
  document.body.appendChild(label);

  const popup = document.createElement('div');
  popup.id = '__omni-popup';
  popup.style.cssText = [
    'position:fixed', 'display:none', 'z-index:2147483647',
    'background:rgba(28,28,30,0.96)', 'color:#f5f5f7',
    'border:1px solid rgba(255,255,255,0.12)', 'border-radius:12px',
    'box-shadow:0 10px 28px rgba(0,0,0,0.45)',
    'padding:10px 12px', 'min-width:280px', 'max-width:380px',
    'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif',
    'font-size:13px', 'letter-spacing:-0.01em',
    'backdrop-filter:blur(20px)', '-webkit-backdrop-filter:blur(20px)',
  ].join(';') + ';';
  popup.innerHTML =
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
      '<span id="__omni-popup-tag" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#0a84ff;font-weight:600;"></span>' +
      '<span id="__omni-popup-text" style="flex:1;color:#aaaaae;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>' +
      '<button id="__omni-popup-close" type="button" style="background:none;border:none;color:#7c7c80;cursor:pointer;font-size:18px;line-height:1;padding:0 4px;font-family:inherit;">&times;</button>' +
    '</div>' +
    '<div id="__omni-popup-row" style="display:flex;gap:6px;">' +
      '<input id="__omni-popup-input" type="text" placeholder="What should change?" autocomplete="off" spellcheck="false" ' +
        'style="flex:1;padding:7px 10px;font-size:13px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:rgba(0,0,0,0.32);color:#f5f5f7;outline:none;font-family:inherit;" />' +
      '<button id="__omni-popup-send" type="button" ' +
        'style="padding:7px 14px;background:#0a84ff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;font-family:inherit;transition:opacity 0.12s;">Send</button>' +
    '</div>' +
    '<div id="__omni-popup-feedback" style="display:none;font-size:13px;font-weight:500;padding:4px 0;"></div>' +
    '<div id="__omni-popup-arrow" style="position:absolute;width:12px;height:12px;background:rgba(28,28,30,0.96);border:1px solid rgba(255,255,255,0.12);display:none;"></div>';
  document.body.appendChild(popup);

  const popupTag = popup.querySelector('#__omni-popup-tag');
  const popupText = popup.querySelector('#__omni-popup-text');
  const popupClose = popup.querySelector('#__omni-popup-close');
  const popupRow = popup.querySelector('#__omni-popup-row');
  const popupInput = popup.querySelector('#__omni-popup-input');
  const popupSend = popup.querySelector('#__omni-popup-send');
  const popupFeedback = popup.querySelector('#__omni-popup-feedback');
  const popupArrow = popup.querySelector('#__omni-popup-arrow');

  let currentEl = null;
  let activeEl = null;
  let popupVisible = false;
  let sending = false;

  function getReactComponent(el) {
    let fiber = null;
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) { fiber = el[key]; break; }
    }
    if (!fiber) return null;
    let node = fiber;
    for (let i = 0; i < 20 && node; i++) {
      if (node.type && typeof node.type === 'function') return node.type.displayName || node.type.name || null;
      if (node.type && typeof node.type === 'object' && node.type.render) return node.type.displayName || node.type.render.displayName || node.type.render.name || null;
      node = node.return;
    }
    return null;
  }

  function getElementInfo(el) {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    return {
      tag, id: el.id ? '#' + el.id : '',
      classes: el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,3).join('.') : '',
      text: (el.textContent || '').trim().slice(0, 80),
      testId: el.getAttribute('data-testid') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      role: el.getAttribute('role') || '',
      component: getReactComponent(el),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles: { color: cs.color, backgroundColor: cs.backgroundColor, fontSize: cs.fontSize, fontWeight: cs.fontWeight, padding: cs.padding, margin: cs.margin, display: cs.display, position: cs.position }
    };
  }

  function positionPopup(targetRect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 8;
    popup.style.left = '-9999px';
    popup.style.top = '0px';
    popup.style.display = 'block';
    const popW = popup.offsetWidth;
    const popH = popup.offsetHeight;
    let top = targetRect.bottom + gap;
    let arrowOnTop = true;
    if (top + popH > vh - 8) {
      top = targetRect.top - popH - gap;
      arrowOnTop = false;
    }
    if (top < 8) top = 8;
    let left = targetRect.left + (targetRect.width / 2) - (popW / 2);
    if (left < 8) left = 8;
    if (left + popW > vw - 8) left = vw - popW - 8;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    const arrowSize = 12;
    let arrowLeft = targetRect.left + (targetRect.width / 2) - left - (arrowSize / 2);
    if (arrowLeft < 10) arrowLeft = 10;
    if (arrowLeft > popW - arrowSize - 10) arrowLeft = popW - arrowSize - 10;
    popupArrow.style.display = 'block';
    popupArrow.style.left = arrowLeft + 'px';
    if (arrowOnTop) {
      popupArrow.style.top = (-arrowSize / 2 - 1) + 'px';
      popupArrow.style.bottom = '';
      popupArrow.style.borderRight = 'none';
      popupArrow.style.borderBottom = 'none';
      popupArrow.style.transform = 'rotate(45deg)';
    } else {
      popupArrow.style.bottom = (-arrowSize / 2 - 1) + 'px';
      popupArrow.style.top = '';
      popupArrow.style.borderLeft = 'none';
      popupArrow.style.borderTop = 'none';
      popupArrow.style.transform = 'rotate(45deg)';
    }
  }

  let submitId = 0;
  let resultTimer = null;

  function resetInputRow() {
    popupRow.style.display = 'flex';
    popupFeedback.style.display = 'none';
    popupFeedback.textContent = '';
    popupInput.value = '';
    popupInput.disabled = false;
    popupSend.disabled = false;
    popupSend.textContent = 'Send';
    popupSend.style.opacity = '1';
    popupSend.style.cursor = 'pointer';
  }

  function showPopup(el, info) {
    activeEl = el;
    const niceTag = info.component ? '<' + info.component + '>' : '<' + info.tag + '>';
    popupTag.textContent = niceTag;
    popupText.textContent = info.text ? '\\u201c' + info.text.slice(0, 40) + '\\u201d' : '';
    resetInputRow();
    sending = false;
    positionPopup(el.getBoundingClientRect());
    popupVisible = true;
    overlay.style.left = info.rect.x + 'px';
    overlay.style.top = info.rect.y + 'px';
    overlay.style.width = info.rect.width + 'px';
    overlay.style.height = info.rect.height + 'px';
    overlay.style.display = 'block';
    setTimeout(function() { popupInput.focus(); popupInput.select(); }, 30);
  }

  function hidePopup(emitDismiss) {
    if (resultTimer) { clearTimeout(resultTimer); resultTimer = null; }
    popup.style.display = 'none';
    activeEl = null;
    popupVisible = false;
    sending = false;
    popupRow.style.display = 'flex';
    popupFeedback.style.display = 'none';
    popupInput.disabled = false;
    popupSend.disabled = false;
    if (emitDismiss) console.log('__omni_element_dismiss__');
  }

  function showFeedback(ok, message) {
    popupRow.style.display = 'none';
    popupFeedback.textContent = message;
    popupFeedback.style.color = ok ? '#30d158' : '#ff453a';
    popupFeedback.style.display = 'block';
  }

  window.__omniOnDesignResult = function(result) {
    if (!result || result.id !== submitId) return;
    if (!popupVisible || !sending) return;
    showFeedback(!!result.ok, String(result.message || (result.ok ? 'Applied.' : 'Failed.')));
    if (resultTimer) clearTimeout(resultTimer);
    resultTimer = setTimeout(function() { hidePopup(false); }, result.ok ? 900 : 2400);
  };

  function submitPopup() {
    if (sending) return;
    const text = popupInput.value.trim();
    if (!text || !activeEl) return;
    sending = true;
    submitId += 1;
    const id = submitId;
    popupSend.textContent = 'Sending\\u2026';
    popupSend.disabled = true;
    popupSend.style.opacity = '0.6';
    popupSend.style.cursor = 'default';
    popupInput.disabled = true;
    const info = getElementInfo(activeEl);
    console.log('__omni_element_prompt_submit__' + JSON.stringify({ id: id, element: info, prompt: text }));
    if (resultTimer) clearTimeout(resultTimer);
    resultTimer = setTimeout(function() {
      if (!popupVisible || !sending || submitId !== id) return;
      showFeedback(false, 'No response (timed out).');
      resultTimer = setTimeout(function() { hidePopup(false); }, 1500);
    }, 8000);
  }

  popupClose.addEventListener('click', function(e) { e.stopPropagation(); hidePopup(true); });
  popupSend.addEventListener('click', function(e) { e.stopPropagation(); submitPopup(); });
  popupInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPopup(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hidePopup(true); }
  });

  function onMouseMove(e) {
    if (popupVisible) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === label) return;
    if (popup.contains(el)) return;
    currentEl = el;
    const rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px'; overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px'; overlay.style.height = rect.height + 'px';
    const component = getReactComponent(el);
    const tag = el.tagName.toLowerCase();
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : '';
    label.textContent = (component ? '<' + component + '> ' : '') + tag + cls;
    label.style.display = 'block';
    label.style.left = rect.left + 'px'; label.style.top = Math.max(0, rect.top - 22) + 'px';
  }
  function onClick(e) {
    if (popup.contains(e.target)) return;
    let el = currentEl;
    if (popupVisible) {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (hit && hit !== overlay && hit !== label && !popup.contains(hit)) el = hit;
    }
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    currentEl = el;
    window.__omniSelectedEl = el;
    const info = getElementInfo(el);
    console.log('__omni_element_select__' + JSON.stringify(info));
    showPopup(el, info);
  }
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);

  window.__omniDisableDesignMode = function() {
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    if (resultTimer) { clearTimeout(resultTimer); resultTimer = null; }
    overlay.remove(); label.remove(); popup.remove();
    delete window.__omniDesignMode;
    delete window.__omniDisableDesignMode;
    delete window.__omniOnDesignResult;
  };
})();
`;

/**
 * Register every `omnigent:browser-*` IPC handler. Idempotent per process is
 * NOT guaranteed — call exactly once from main.js's registerIpc.
 *
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {(event: Electron.IpcMainInvokeEvent) => boolean} deps.isPinnedOriginSender
 *        The privileged-origin trust gate. Load-bearing — applied to every handler.
 * @param {(event: Electron.IpcMainInvokeEvent) =>
 *          (import('./browserViewRegistry').Registry | null)} deps.getRegistryForEvent
 *        Resolves the sender window's own browser-view registry.
 */
function registerBrowserIpc({ ipcMain, isPinnedOriginSender, getRegistryForEvent }) {
  /**
   * Resolve the sender's registry after the privileged-origin gate. Returns
   * `{ registry }` on success or `{ error }` (a structured result, never a
   * throw) so the relay/toolbar surfaces a clean error.
   */
  const gateRegistry = (event) => {
    if (!isPinnedOriginSender(event)) {
      return { error: "browser IPC is only available to the connected server's page" };
    }
    const registry = getRegistryForEvent(event);
    if (!registry) return { error: "no browser registry for this window" };
    return { registry };
  };

  /** A window-scoped sender for the event's own webContents. Used to push
   *  url/nav-state pings back to exactly the renderer that drives the view. */
  const senderFor = (event) => (channel, payload) => {
    try {
      event.sender.send(channel, payload);
    } catch {
      /* window torn down */
    }
  };

  // Open (create-if-absent) or navigate a conversation's view, and measure it
  // into place. `force` reloads even on the same URL (agent "bring me back"
  // intent). Returns the registry's structured `{ ok, created, error }`.
  ipcMain.handle("omnigent:browser-open-or-navigate", (event, args) => {
    const g = gateRegistry(event);
    if (g.error) return { ok: false, error: g.error };
    const { conversationId, url, bounds, opts } = args ?? {};
    if (typeof conversationId !== "string" || !conversationId) {
      return { ok: false, error: "conversationId is required" };
    }
    const r = g.registry.openOrNavigate(conversationId, url, bounds, opts);
    // On first creation, wire the nav listeners so the URL bar can live-track
    // the real url. Attached here (not in the registry factory) so the registry
    // stays a pure, Electron-free factory; `event.sender` is the window that
    // owns this view for its whole lifetime.
    if (r.ok && r.created && r.entry) {
      attachNavListeners({
        conversationId,
        webContents: r.entry.view.webContents,
        send: senderFor(event),
      });
    }
    // Strip the non-serializable `entry` before it crosses the IPC boundary.
    return { ok: r.ok, created: r.created ?? false, error: r.error };
  });

  // Attach the named conversation's view to the host window (detaching the
  // previous active one), or detach everything when conversationId is null.
  ipcMain.handle("omnigent:browser-set-active", (event, args) => {
    const g = gateRegistry(event);
    if (g.error) return { ok: false, error: g.error };
    const conversationId = args?.conversationId ?? null;
    const r = g.registry.setActive(conversationId);
    return { ok: r.ok, error: r.error };
  });

  // Reposition the active conversation's view to freshly-measured bounds.
  ipcMain.handle("omnigent:browser-resize", (event, args) => {
    const g = gateRegistry(event);
    if (g.error) return { ok: false, error: g.error };
    const { conversationId, bounds } = args ?? {};
    if (typeof conversationId !== "string" || !conversationId) {
      return { ok: false, error: "conversationId is required" };
    }
    const entry = g.registry.get(conversationId);
    if (!entry) return { ok: false, error: "No browser view" };
    if (bounds) entry.boundsController.setRendererBounds(bounds);
    return { ok: true };
  });

  // Capture the conversation's view as a base64 PNG.
  ipcMain.handle("omnigent:browser-screenshot", async (event, args) => {
    const g = gateRegistry(event);
    if (g.error) return { ok: false, error: g.error };
    const { conversationId } = args ?? {};
    const entry = g.registry.get(conversationId);
    if (!entry) return { ok: false, error: "No browser view" };
    try {
      const image = await entry.view.webContents.capturePage();
      const dataUrl = `data:image/png;base64,${image.toPNG().toString("base64")}`;
      return { ok: true, dataUrl };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  // Run relay-template JS in the conversation's view. PRIVATE to the relay's
  // fixed templates (snapshot / click / type) — NOT an agent-facing generic
  // `evaluate` (Risk-4 trust boundary; see README).
  ipcMain.handle("omnigent:browser-execute", async (event, args) => {
    const g = gateRegistry(event);
    if (g.error) return { ok: false, error: g.error };
    const { conversationId, js } = args ?? {};
    if (typeof js !== "string") return { ok: false, error: "js must be a string" };
    const entry = g.registry.get(conversationId);
    if (!entry) return { ok: false, error: "No browser view" };
    try {
      // `true` = user gesture, so the page can call gesture-gated APIs.
      const result = await entry.view.webContents.executeJavaScript(js, true);
      // Normalize to a string — the relay JSON.parses snapshot/upload results.
      return { ok: true, result: typeof result === "string" ? result : JSON.stringify(result) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  // Whether a view currently exists for a conversation. Lets a (re)mounting
  // pane re-attach an already-created view without waiting for a create event.
  ipcMain.handle("omnigent:browser-has-view", (event, args) => {
    const g = gateRegistry(event);
    if (g.error) return { exists: false };
    const { conversationId } = args ?? {};
    return { exists: typeof conversationId === "string" && g.registry.has(conversationId) };
  });

  // Destroy the conversation's view (explicit close — unmount only detaches).
  ipcMain.handle("omnigent:browser-close", (event, args) => {
    const g = gateRegistry(event);
    if (g.error) return { ok: false, error: g.error };
    const { conversationId, reason } = args ?? {};
    const r = g.registry.close(conversationId, reason);
    return { ok: r.ok, removed: r.removed ?? false };
  });

  // ── Toolbar: history navigation ──────────────────────────────────────────
  // Back / forward / reload for the URL-bar toolbar. Each returns the fresh
  // nav-state so the caller can update button-disabled state immediately (the
  // did-navigate listener also pushes a browser-nav-state event once the
  // navigation lands, but returning it here avoids a round-trip flicker).

  ipcMain.handle("omnigent:browser-go-back", (event, args) => {
    const g = gateRegistry(event);
    if (g.error) return { ok: false, error: g.error };
    const entry = g.registry.get(args?.conversationId);
    if (!entry) return { ok: false, error: "No browser view" };
    goBack(entry.view.webContents);
    return { ok: true, ...readNavState(entry.view.webContents) };
  });

  ipcMain.handle("omnigent:browser-go-forward", (event, args) => {
    const g = gateRegistry(event);
    if (g.error) return { ok: false, error: g.error };
    const entry = g.registry.get(args?.conversationId);
    if (!entry) return { ok: false, error: "No browser view" };
    goForward(entry.view.webContents);
    return { ok: true, ...readNavState(entry.view.webContents) };
  });

  ipcMain.handle("omnigent:browser-reload", (event, args) => {
    const g = gateRegistry(event);
    if (g.error) return { ok: false, error: g.error };
    const entry = g.registry.get(args?.conversationId);
    if (!entry) return { ok: false, error: "No browser view" };
    try {
      entry.view.webContents.reload();
    } catch {
      /* destroyed */
    }
    return { ok: true };
  });

  // ── Toolbar: DevTools toggle ─────────────────────────────────────────────
  // Toggle Chrome DevTools docked at the bottom of the view (matches SP2K's
  // UX). Docked 'bottom' shares the view's bounds — the syncBounds rAF loop
  // already covers the whole pane, so Chromium splits page + devtools inside it.
  ipcMain.handle("omnigent:open-browser-devtools", (event, args) => {
    const g = gateRegistry(event);
    if (g.error) return { ok: false, error: g.error };
    const entry = g.registry.get(args?.conversationId);
    if (!entry) return { ok: false, error: "No browser view" };
    try {
      const wc = entry.view.webContents;
      if (wc.isDevToolsOpened()) {
        wc.closeDevTools();
      } else {
        wc.openDevTools({ mode: "bottom" });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  // ── Design mode (point-and-prompt) ───────────────────────────────────────
  // Enable/disable the in-page picker and signal a submit's result back into
  // the popup. Each stores/detaches a per-entry console-message listener so a
  // late marker from a background conversation can't leak into another's UI.
  // The registry's `close()` also detaches the listener on teardown.

  ipcMain.handle("omnigent:browser-enable-design-mode", async (event, args) => {
    const g = gateRegistry(event);
    if (g.error) return { ok: false, error: g.error };
    const { conversationId } = args ?? {};
    const entry = g.registry.get(conversationId);
    if (!entry) return { ok: false, error: "No browser view" };
    try {
      await entry.view.webContents.executeJavaScript(DESIGN_MODE_SCRIPT);
      // Detach any prior handler so toggling on/off doesn't stack listeners.
      if (entry.designModeListener && entry.designModeWebContents) {
        try {
          entry.designModeWebContents.removeListener("console-message", entry.designModeListener);
        } catch {
          /* destroyed */
        }
      }
      const handler = makeDesignModeConsoleHandler(conversationId, entry, senderFor(event));
      entry.designModeListener = handler;
      entry.designModeWebContents = entry.view.webContents;
      entry.designModeWebContents.on("console-message", handler);
      return { ok: true };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (msg.includes("Object has been destroyed")) return { ok: false, error: "browser closed" };
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle("omnigent:browser-disable-design-mode", async (event, args) => {
    const g = gateRegistry(event);
    if (g.error) return { ok: false, error: g.error };
    const { conversationId } = args ?? {};
    const entry = g.registry.get(conversationId);
    if (!entry) return { ok: false };
    if (entry.designModeListener && entry.designModeWebContents) {
      try {
        entry.designModeWebContents.removeListener("console-message", entry.designModeListener);
      } catch {
        /* destroyed */
      }
    }
    entry.designModeListener = null;
    entry.designModeWebContents = null;
    try {
      await entry.view.webContents.executeJavaScript(
        "window.__omniDisableDesignMode && window.__omniDisableDesignMode()",
      );
    } catch {
      /* destroyed */
    }
    return { ok: true };
  });

  // Forward a submit's success/failure envelope into the page so the popup
  // shows green/red feedback. `id` matches the page-generated submitId so a
  // late callback for a prior submit doesn't paint over a fresh popup. The
  // fields are defensively coerced before crossing back into the page.
  ipcMain.handle("omnigent:browser-signal-design-result", async (event, payload) => {
    const g = gateRegistry(event);
    if (g.error) return { ok: false, error: g.error };
    if (!payload || typeof payload !== "object") return { ok: false, error: "bad payload" };
    const entry = g.registry.get(payload.conversationId);
    if (!entry) return { ok: false, error: "No browser view" };
    const safe = {
      id: typeof payload.id === "number" ? payload.id : 0,
      ok: !!payload.ok,
      message: typeof payload.message === "string" ? payload.message : "",
    };
    try {
      await entry.view.webContents.executeJavaScript(
        `window.__omniOnDesignResult && window.__omniOnDesignResult(${JSON.stringify(safe)})`,
      );
      return { ok: true };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (msg.includes("Object has been destroyed")) return { ok: false, error: "browser closed" };
      return { ok: false, error: msg };
    }
  });
}

module.exports = {
  registerBrowserIpc,
  // Exported for unit tests (drive nav-state / listener logic without Electron).
  attachNavListeners,
  readNavState,
  goBack,
  goForward,
};
