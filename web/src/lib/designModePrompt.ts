/** Design-mode prompt helpers.
 *
 *  Pure functions used by AppShell's element-prompt-submit listener to turn a
 *  picked element + user prompt into a chat message. Kept out of the component
 *  so they're unit-testable without a React render.
 *
 *  Unlike SP2K there is NO backend design-edit route: the element prompt is
 *  sent as an ordinary user message through `chatStore.send`, with the cropped
 *  element screenshot riding along as an attachment File. So this is a pure
 *  client affordance — see AppShell + BrowserPane. */

/** The element info the in-page picker emits (mirrors DESIGN_MODE_SCRIPT's
 *  getElementInfo). All fields optional — an older injected script or an
 *  unusual element may omit some. */
export interface DesignModeElement {
  tag?: string;
  id?: string;
  classes?: string;
  text?: string;
  testId?: string;
  ariaLabel?: string;
  role?: string;
  component?: string | null;
}

/** Human-readable element name: prefer the React component, else the tag. */
function displayName(el: DesignModeElement): string {
  if (el.component) return `<${el.component}>`;
  return `<${el.tag ?? "element"}>`;
}

/** Best-effort CSS selector for the element, matching SP2K's precedence:
 *  data-testid → id → tag+classes. */
function selectorFor(el: DesignModeElement): string {
  if (el.testId) return `[data-testid="${el.testId}"]`;
  if (el.id) return el.id; // already carries the leading '#'
  return `${el.tag ?? ""}${el.classes ?? ""}`;
}

/**
 * Build the chat message text for a design-mode submit: the user's prompt
 * followed by a fenced `[Design Mode — …]` context block describing the picked
 * element. The block shape mirrors SP2K so any downstream parser that strips it
 * from the rendered bubble stays compatible.
 *
 * @param element the picked element info
 * @param prompt the user's typed instruction
 * @returns the full message text to send
 */
export function buildDesignModePrompt(element: DesignModeElement, prompt: string): string {
  const ctx = [
    `[Design Mode — modify this element in the browser preview]`,
    `Element: ${displayName(element)}`,
    `CSS selector: ${selectorFor(element)}`,
    element.text ? `Text: "${element.text}"` : "",
    element.ariaLabel ? `Aria-label: "${element.ariaLabel}"` : "",
    element.role ? `Role: ${element.role}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `${prompt}\n\n---\n${ctx}\n---`;
}

/**
 * Convert a base64 data URL (the cropped element screenshot the main process
 * captured) into a `File` so it can ride the normal chat-send attachment path.
 * Returns null if the input isn't a usable `data:image/...;base64,...` URL.
 *
 * @param dataUrl e.g. "data:image/png;base64,iVBORw0K…"
 * @param filename the attachment filename
 */
export function dataUrlToFile(dataUrl: string | null | undefined, filename: string): File | null {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || "image/png";
  const isBase64 = !!match[2];
  const data = match[3] ?? "";
  try {
    const raw = isBase64 ? atob(data) : decodeURIComponent(data);
    // Back the bytes with a plain ArrayBuffer (not the SharedArrayBuffer-union
    // TS infers for a bare Uint8Array) so the BlobPart type checks cleanly.
    const buffer = new ArrayBuffer(raw.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new File([buffer], filename, { type: mime });
  } catch {
    return null;
  }
}
