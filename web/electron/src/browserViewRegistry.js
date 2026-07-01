/**
 * Per-conversation WebContentsView registry.
 *
 * Ported from SP2K `electron/browserViewRegistry.js`, renaming `taskId` ->
 * `conversationId` for Omnigent's session model. Each entry owns its own
 * bounds controller so per-conversation state never cross-contaminates.
 *
 * Pure factory — no Electron imports at module scope. All deps are injected
 * so a unit test can drive create/swap/close/closeAll/cap behavior with a
 * stub `WebContentsViewCtor` without booting Electron.
 *
 * Lifecycle invariants:
 *  - `setActive(conversationId)` NEVER lazy-creates a view — it only attaches
 *    an existing entry. Returns `{ok:false, error:'No browser view'}` when no
 *    entry exists. This is what lets a background-conversation agent operate
 *    on its own view without the user's panel mounts implicitly creating blank
 *    views for every switched-to conversation.
 *  - Creation goes through `getOrCreate` or `openOrNavigate` only. Both
 *    enforce the cap; both return structured errors instead of throwing.
 *  - The registry detaches the old active entry before attaching the new one —
 *    inactive entries are alive (JS still runs, agent IPCs still work) but
 *    their painting is suspended. Closing them is explicit (DETACH-not-destroy
 *    on hide; destroy only on explicit close).
 */

const DEFAULT_CAP = 10;

function createBrowserViewRegistry({
  WebContentsViewCtor, // (opts) => new WebContentsView(opts) — injectable for tests
  createBoundsController, // bounds-controller factory (createBrowserViewBoundsController)
  attachToHost, // (view) => mainWindow.contentView.addChildView(view)
  detachFromHost, // (view) => mainWindow.contentView.removeChildView(view)
  sendToRenderer, // (channel, payload) => mainWindow.webContents.send(...)
  getHostZoomFactor = () => 1,
  getHostDisplayScaleFactor = () => null,
  cap = DEFAULT_CAP,
} = {}) {
  const entries = new Map(); // conversationId -> BrowserViewEntry
  let activeConversationId = null;

  function makeEntry(conversationId, view) {
    const entry = {
      conversationId,
      view,
      boundsController: createBoundsController({
        getZoomFactor: getHostZoomFactor,
        getDisplayScaleFactor: getHostDisplayScaleFactor,
        setBounds: (bounds) => {
          // Only paint if this entry is the active one. Inactive entries keep
          // their last-known renderer bounds for restore on activate, but we
          // don't call setBounds() on them — would be a no-op on a detached
          // view anyway.
          if (activeConversationId === conversationId) {
            try {
              view.setBounds(bounds);
            } catch {
              /* destroyed */
            }
          }
        },
      }),
      // Last URL we EXPLICITLY asked the entry to load. Compared against future
      // openOrNavigate calls to decide whether to reissue loadURL. Using
      // getURL() instead doesn't work because user/agent navigations inside the
      // page advance it past the initial URL — panel re-mounts would then see a
      // mismatch and force a refresh.
      lastRequestedUrl: '',
    };
    return entry;
  }

  function get(conversationId) {
    return entries.get(conversationId) || null;
  }

  function getOrCreate(conversationId) {
    const existing = entries.get(conversationId);
    if (existing) return { ok: true, entry: existing, created: false };
    if (entries.size >= cap) {
      return { ok: false, error: 'browser view cap reached — close one', cap };
    }
    const view = WebContentsViewCtor({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    const entry = makeEntry(conversationId, view);
    entries.set(conversationId, entry);
    return { ok: true, entry, created: true };
  }

  function openOrNavigate(conversationId, url, bounds, opts) {
    const force = !!(opts && opts.force);
    const result = getOrCreate(conversationId);
    if (!result.ok) return result;
    const { entry, created } = result;
    if (bounds) entry.boundsController.setRendererBounds(bounds);
    // Only attach immediately when this is the active conversation; otherwise
    // create-detached and let `setActive(conversationId)` attach on user switch.
    if (created && activeConversationId === conversationId) {
      try {
        attachToHost(entry.view);
      } catch {
        /* host gone */
      }
    }
    if (url) {
      // Compare against the LAST URL we explicitly requested, not
      // webContents.getURL(). The currently-loaded URL drifts as the user/agent
      // clicks links inside the page, so a panel re-mount for a conversation
      // whose slice URL stayed the same would otherwise see a mismatch and
      // reissue loadURL — yanking the user back to the initial URL. Tracking the
      // last EXPLICITLY requested URL means:
      //   - first call with a fresh entry -> load (created or not)
      //   - panel re-mount with the same slice URL -> skip (no refresh)
      //   - explicit nav (relay or URL-bar) to a different URL -> load
      //   - `force: true` from the agent relay -> load even on same URL so an
      //     agent's "bring the user back to the canonical URL" intent isn't
      //     silently dropped after in-page navigation.
      if (created || force || entry.lastRequestedUrl !== url) {
        entry.lastRequestedUrl = url;
        try {
          entry.view.webContents.loadURL(url);
        } catch (e) {
          return { ok: false, error: `loadURL failed: ${e && e.message ? e.message : e}` };
        }
      }
    }
    return { ok: true, entry, created };
  }

  function setActive(conversationId) {
    // conversationId === null is the "detach everything" sentinel. The renderer
    // calls this when no browser-pane is mounted so the previous active view
    // stops painting over the React layout. The view stays in the registry —
    // the per-conversation agent can still drive it via openOrNavigate.
    if (conversationId === null || conversationId === undefined) {
      if (activeConversationId !== null) {
        const prev = entries.get(activeConversationId);
        if (prev) {
          try {
            detachFromHost(prev.view);
          } catch {}
        }
        activeConversationId = null;
        sendToRenderer('browser-host-active-changed', { conversationId: null });
      }
      return { ok: true };
    }
    const next = entries.get(conversationId);
    if (!next) {
      // No view for the requested conversation. "Make this active" with nothing
      // to make active should still DETACH whatever was previously visible —
      // otherwise switching from A (has browser) to B (no browser) leaves A's
      // view painted over B's page. Treat this as an implicit detach.
      if (activeConversationId !== null) {
        const prev = entries.get(activeConversationId);
        if (prev) {
          try {
            detachFromHost(prev.view);
          } catch {}
        }
        activeConversationId = null;
        sendToRenderer('browser-host-active-changed', { conversationId: null });
      }
      return { ok: false, error: 'No browser view' };
    }
    if (activeConversationId === conversationId) {
      // Already active — repositioning bounds is a re-apply, not a swap.
      next.boundsController.resync();
      return { ok: true };
    }
    if (activeConversationId !== null) {
      const prev = entries.get(activeConversationId);
      if (prev) {
        try {
          detachFromHost(prev.view);
        } catch {
          /* detached / destroyed */
        }
      }
    }
    activeConversationId = conversationId;
    try {
      attachToHost(next.view);
    } catch {
      /* host gone */
    }
    next.boundsController.resync();
    sendToRenderer('browser-host-active-changed', { conversationId });
    return { ok: true };
  }

  function close(conversationId, reason) {
    const entry = entries.get(conversationId);
    if (!entry) return { ok: true, removed: false };
    if (activeConversationId === conversationId) {
      try {
        detachFromHost(entry.view);
      } catch {}
      activeConversationId = null;
    }
    entry.boundsController.clear();
    try {
      entry.view.webContents.close();
    } catch {
      /* already destroyed */
    }
    entries.delete(conversationId);
    sendToRenderer('browser-view-closed', { conversationId, reason: reason || null });
    return { ok: true, removed: true };
  }

  function closeAll(reason) {
    for (const conversationId of [...entries.keys()]) {
      close(conversationId, reason);
    }
  }

  return {
    // Lifecycle
    get,
    getOrCreate,
    openOrNavigate,
    setActive,
    close,
    closeAll,
    // Introspection
    activeConversationId: () => activeConversationId,
    size: () => entries.size,
    has: (conversationId) => entries.has(conversationId),
    forEach: (fn) => entries.forEach(fn),
    // Constants exposed for tests / main.js wiring
    cap,
  };
}

module.exports = {
  createBrowserViewRegistry,
  DEFAULT_CAP,
};
