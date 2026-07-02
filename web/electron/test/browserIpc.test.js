// Tests for the extracted browser IPC module (src/browserIpc.js), run with
// `node --test`. registerBrowserIpc takes injected deps (ipcMain, trust gate,
// registry resolver) so we can drive every handler with stubs — no Electron.
//
// Coverage focus:
//   - the trust gate (isPinnedOriginSender) is applied to EVERY handler,
//     including the new toolbar ones (go-back / go-forward / reload / devtools);
//   - go-back / go-forward respect canGoBack / canGoForward;
//   - devtools TOGGLES (open when closed, close when open);
//   - the did-navigate listeners wired on create emit browser-url-changed +
//     browser-nav-state to the sender;
//   - navigationHistory (Electron 42) is preferred, with a legacy fallback.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  registerBrowserIpc,
  readNavState,
  goBack,
  goForward,
} = require("../src/browserIpc");

/** A fake ipcMain that records `handle(channel, fn)` registrations and lets a
 *  test invoke a channel with a synthetic event + args. */
function makeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    invoke(channel, event, args) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn(event, args);
    },
    channels: () => [...handlers.keys()],
  };
}

/** A stub webContents with a navigationHistory (Electron 42) and toggleable
 *  devtools + recorded navigation calls. */
function makeWebContents({ canBack = false, canForward = false } = {}) {
  const calls = [];
  const listeners = new Map();
  let devtoolsOpen = false;
  return {
    calls,
    listeners,
    navigationHistory: {
      canGoBack: () => canBack,
      canGoForward: () => canForward,
      goBack: () => calls.push("goBack"),
      goForward: () => calls.push("goForward"),
    },
    reload: () => calls.push("reload"),
    isDevToolsOpened: () => devtoolsOpen,
    openDevTools: (opts) => {
      devtoolsOpen = true;
      calls.push(`openDevTools:${opts?.mode}`);
    },
    closeDevTools: () => {
      devtoolsOpen = false;
      calls.push("closeDevTools");
    },
    on: (evt, fn) => listeners.set(evt, fn),
    emit: (evt, ...eventArgs) => listeners.get(evt)?.({}, ...eventArgs),
  };
}

/** Build a registry stub around one entry keyed by conversationId. */
function makeRegistry(conversationId, webContents) {
  const entries = new Map();
  if (conversationId) entries.set(conversationId, { view: { webContents } });
  return {
    get: (id) => entries.get(id) ?? null,
    has: (id) => entries.has(id),
    openOrNavigate: (id) => {
      const wc = makeWebContents();
      const entry = { view: { webContents: wc } };
      entries.set(id, entry);
      return { ok: true, created: true, entry };
    },
    setActive: () => ({ ok: true }),
    close: () => ({ ok: true, removed: true }),
  };
}

/** Register the IPC surface with injectable gate + registry, and capture the
 *  events sent to a fake sender. */
function setup({ pinned = true, conversationId = "conv_1", webContents } = {}) {
  const ipcMain = makeIpcMain();
  const wc = webContents ?? makeWebContents();
  const registry = makeRegistry(conversationId, wc);
  const sent = [];
  const event = { sender: { send: (channel, payload) => sent.push({ channel, payload }) } };
  registerBrowserIpc({
    ipcMain,
    isPinnedOriginSender: () => pinned,
    getRegistryForEvent: () => registry,
  });
  return { ipcMain, registry, wc, sent, event };
}

describe("browserIpc — trust gate", () => {
  it("registers every browser-* channel", () => {
    const { ipcMain } = setup();
    const channels = ipcMain.channels();
    for (const ch of [
      "omnigent:browser-open-or-navigate",
      "omnigent:browser-set-active",
      "omnigent:browser-resize",
      "omnigent:browser-screenshot",
      "omnigent:browser-execute",
      "omnigent:browser-has-view",
      "omnigent:browser-close",
      "omnigent:browser-go-back",
      "omnigent:browser-go-forward",
      "omnigent:browser-reload",
      "omnigent:open-browser-devtools",
    ]) {
      assert.ok(channels.includes(ch), `missing handler: ${ch}`);
    }
  });

  it("rejects an unpinned sender on the new toolbar handlers", async () => {
    const { ipcMain, event } = setup({ pinned: false });
    const channels = [
      "omnigent:browser-go-back",
      "omnigent:browser-go-forward",
      "omnigent:browser-reload",
      "omnigent:open-browser-devtools",
    ];
    const results = await Promise.all(
      channels.map((ch) => ipcMain.invoke(ch, event, { conversationId: "conv_1" })),
    );
    results.forEach((r, i) => {
      assert.equal(r.ok, false, `${channels[i]} should be gated`);
      assert.match(r.error, /connected server's page/);
    });
  });
});

describe("browserIpc — history navigation", () => {
  it("go-back issues goBack only when canGoBack is true", async () => {
    const wc = makeWebContents({ canBack: true });
    const { ipcMain, event } = setup({ webContents: wc });
    const r = await ipcMain.invoke("omnigent:browser-go-back", event, { conversationId: "conv_1" });
    assert.equal(r.ok, true);
    assert.ok(wc.calls.includes("goBack"));
  });

  it("go-back is a no-op when canGoBack is false", async () => {
    const wc = makeWebContents({ canBack: false });
    const { ipcMain, event } = setup({ webContents: wc });
    const r = await ipcMain.invoke("omnigent:browser-go-back", event, { conversationId: "conv_1" });
    assert.equal(r.ok, true);
    assert.ok(!wc.calls.includes("goBack"));
  });

  it("go-forward issues goForward when canGoForward is true", async () => {
    const wc = makeWebContents({ canForward: true });
    const { ipcMain, event } = setup({ webContents: wc });
    await ipcMain.invoke("omnigent:browser-go-forward", event, { conversationId: "conv_1" });
    assert.ok(wc.calls.includes("goForward"));
  });

  it("reload calls webContents.reload", async () => {
    const wc = makeWebContents();
    const { ipcMain, event } = setup({ webContents: wc });
    await ipcMain.invoke("omnigent:browser-reload", event, { conversationId: "conv_1" });
    assert.ok(wc.calls.includes("reload"));
  });

  it("returns {ok:false} for a missing view", async () => {
    const { ipcMain, event } = setup({ conversationId: null });
    const r = await ipcMain.invoke("omnigent:browser-go-back", event, { conversationId: "nope" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "No browser view");
  });
});

describe("browserIpc — devtools toggle", () => {
  it("opens devtools docked bottom when closed, closes when open", async () => {
    const wc = makeWebContents();
    const { ipcMain, event } = setup({ webContents: wc });
    await ipcMain.invoke("omnigent:open-browser-devtools", event, { conversationId: "conv_1" });
    assert.ok(wc.calls.includes("openDevTools:bottom"));
    await ipcMain.invoke("omnigent:open-browser-devtools", event, { conversationId: "conv_1" });
    assert.ok(wc.calls.includes("closeDevTools"));
  });
});

describe("browserIpc — url live-tracking", () => {
  it("open-or-navigate wires did-navigate listeners that emit url + nav-state", async () => {
    const { ipcMain, registry, sent, event } = setup({ conversationId: null });
    await ipcMain.invoke("omnigent:browser-open-or-navigate", event, {
      conversationId: "conv_1",
      url: "https://example.com",
    });
    // The created entry's webContents got did-navigate listeners.
    const wc = registry.get("conv_1").view.webContents;
    wc.emit("did-navigate", "https://example.com/after-redirect");
    const urlEvents = sent.filter((s) => s.channel === "browser-url-changed");
    const navEvents = sent.filter((s) => s.channel === "browser-nav-state");
    assert.equal(urlEvents.length, 1);
    assert.deepEqual(urlEvents[0].payload, {
      conversationId: "conv_1",
      url: "https://example.com/after-redirect",
    });
    assert.equal(navEvents.length, 1);
    assert.equal(navEvents[0].payload.conversationId, "conv_1");
  });

  it("did-navigate-in-page only emits for the main frame", async () => {
    const { ipcMain, registry, sent, event } = setup({ conversationId: null });
    await ipcMain.invoke("omnigent:browser-open-or-navigate", event, {
      conversationId: "conv_1",
      url: "https://example.com",
    });
    const wc = registry.get("conv_1").view.webContents;
    wc.emit("did-navigate-in-page", "https://example.com/#sub", false); // subframe → ignored
    assert.equal(sent.filter((s) => s.channel === "browser-url-changed").length, 0);
    wc.emit("did-navigate-in-page", "https://example.com/#main", true); // main frame → emits
    assert.equal(sent.filter((s) => s.channel === "browser-url-changed").length, 1);
  });
});

describe("browserIpc — navigation API helpers", () => {
  it("readNavState prefers navigationHistory (Electron 42)", () => {
    const wc = makeWebContents({ canBack: true, canForward: false });
    assert.deepEqual(readNavState(wc), { canGoBack: true, canGoForward: false });
  });

  it("readNavState falls back to legacy canGoBack/canGoForward", () => {
    const legacy = { canGoBack: () => true, canGoForward: () => true };
    assert.deepEqual(readNavState(legacy), { canGoBack: true, canGoForward: true });
  });

  it("goBack/goForward return whether a navigation was issued", () => {
    const canWc = makeWebContents({ canBack: true, canForward: true });
    assert.equal(goBack(canWc), true);
    assert.equal(goForward(canWc), true);
    const cantWc = makeWebContents({ canBack: false, canForward: false });
    assert.equal(goBack(cantWc), false);
    assert.equal(goForward(cantWc), false);
  });
});
