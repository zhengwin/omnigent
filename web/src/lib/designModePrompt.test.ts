import { describe, expect, it } from "vitest";

import { buildDesignModePrompt, dataUrlToFile } from "./designModePrompt";

describe("buildDesignModePrompt", () => {
  it("prefers the React component name over the tag in the display name", () => {
    const out = buildDesignModePrompt(
      { tag: "button", component: "PrimaryButton", text: "Save" },
      "make it green",
    );
    expect(out).toContain("make it green");
    expect(out).toContain("[Design Mode — modify this element in the browser preview]");
    expect(out).toContain("Element: <PrimaryButton>");
    expect(out).toContain('Text: "Save"');
  });

  it("falls back to the tag when there's no component", () => {
    const out = buildDesignModePrompt({ tag: "div" }, "add padding");
    expect(out).toContain("Element: <div>");
  });

  it("builds the selector with testid → id → tag+classes precedence", () => {
    expect(buildDesignModePrompt({ tag: "a", testId: "nav-home" }, "x")).toContain(
      'CSS selector: [data-testid="nav-home"]',
    );
    expect(buildDesignModePrompt({ tag: "a", id: "#main" }, "x")).toContain("CSS selector: #main");
    expect(buildDesignModePrompt({ tag: "a", classes: ".link.active" }, "x")).toContain(
      "CSS selector: a.link.active",
    );
  });

  it("omits optional lines (text / aria-label / role) when absent", () => {
    const out = buildDesignModePrompt({ tag: "span" }, "tweak");
    expect(out).not.toContain("Text:");
    expect(out).not.toContain("Aria-label:");
    expect(out).not.toContain("Role:");
  });
});

describe("dataUrlToFile", () => {
  it("decodes a base64 image data URL into a File with the right type + name", () => {
    // 1x1 transparent PNG.
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const file = dataUrlToFile(png, "shot.png");
    expect(file).not.toBeNull();
    expect(file?.name).toBe("shot.png");
    expect(file?.type).toBe("image/png");
    expect((file?.size ?? 0) > 0).toBe(true);
  });

  it("returns null for a non-string or non-data-URL input", () => {
    expect(dataUrlToFile(null, "x.png")).toBeNull();
    expect(dataUrlToFile(undefined, "x.png")).toBeNull();
    expect(dataUrlToFile("https://example.com/a.png", "x.png")).toBeNull();
  });
});
