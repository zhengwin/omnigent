import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useManagedArtifacts } from "@/hooks/useManagedArtifacts";
import { ArtifactViewerContext } from "@/shell/ArtifactViewerContext";
import { FileViewerContext } from "@/shell/FileViewerContext";
import { FilePathAwareMessageResponse } from "./BlockRenderer";

vi.mock("@/hooks/useManagedArtifacts", () => ({ useManagedArtifacts: vi.fn() }));

const managedArtifactsMock = vi.mocked(useManagedArtifacts);
const openArtifact = vi.fn();
const openFile = vi.fn();
const ARTIFACT_VIEWER_CONTEXT_VALUE = { openArtifact };

const FILE_VIEWER_CONTEXT_VALUE = {
  openFile,
  isChangedPath: () => false,
  conversationId: "conv_artifacts",
  workspaceRoot: null,
  workspaceHome: null,
};

const MANAGED_ARTIFACTS = [
  {
    path: "artifacts/revenue/index.html",
    name: "index.html",
    type: "file" as const,
    bytes: 200,
    modified_at: 2,
  },
  {
    path: "artifacts/overview.html",
    name: "overview.html",
    type: "file" as const,
    bytes: 100,
    modified_at: 1,
  },
  {
    path: "artifacts/revenue/styles.css",
    name: "styles.css",
    type: "file" as const,
    bytes: 50,
    modified_at: 2,
  },
];

function renderMessage(markdown: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArtifactViewerContext.Provider value={ARTIFACT_VIEWER_CONTEXT_VALUE}>
        <FileViewerContext.Provider value={FILE_VIEWER_CONTEXT_VALUE}>
          <FilePathAwareMessageResponse>{markdown}</FilePathAwareMessageResponse>
        </FileViewerContext.Provider>
      </ArtifactViewerContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  openArtifact.mockReset();
  openFile.mockReset();
  managedArtifactsMock.mockReturnValue({
    data: MANAGED_ARTIFACTS,
    isLoading: false,
    isError: false,
  } as ReturnType<typeof useManagedArtifacts>);
});

afterEach(cleanup);

describe("artifact entry tags", () => {
  it.each(["artifacts/revenue/index.html", "artifacts/overview.html"])(
    "opens the managed artifact %s instead of the workspace file viewer",
    async (entryPath) => {
      renderMessage(`Open \`${entryPath}\` to review it.`);

      fireEvent.click(await screen.findByRole("button", { name: entryPath }));

      expect(openArtifact).toHaveBeenCalledWith(entryPath);
      expect(openFile).not.toHaveBeenCalled();
    },
  );

  it("supports Enter and Space keyboard activation", async () => {
    renderMessage("Review `artifacts/revenue/index.html`.");
    const tag = await screen.findByRole("button", {
      name: "artifacts/revenue/index.html",
    });

    fireEvent.keyDown(tag, { key: "Enter" });
    fireEvent.keyDown(tag, { key: " " });

    expect(openArtifact).toHaveBeenNthCalledWith(1, "artifacts/revenue/index.html");
    expect(openArtifact).toHaveBeenNthCalledWith(2, "artifacts/revenue/index.html");
  });

  it("selects the artifact tag that was activated when several are displayed", async () => {
    renderMessage("Compare `artifacts/revenue/index.html` with `artifacts/overview.html`.");

    fireEvent.click(await screen.findByRole("button", { name: "artifacts/overview.html" }));

    expect(openArtifact).toHaveBeenCalledTimes(1);
    expect(openArtifact).toHaveBeenCalledWith("artifacts/overview.html");
  });

  it.each([
    "artifacts/missing/index.html",
    "artifacts/team/dashboard.html",
    "artifacts/revenue/styles.css",
  ])("leaves a stale or unsupported artifact-like tag inert: %s", async (entryPath) => {
    renderMessage(`Reference \`${entryPath}\`.`);

    const tag = await screen.findByText(entryPath, { selector: "code" });
    expect(tag).not.toHaveAttribute("role", "button");
    expect(tag).not.toHaveAttribute("tabindex");
  });

  it("does not turn ordinary inline code or plain artifact text into links", async () => {
    renderMessage("Use `artifact` while artifacts/revenue/index.html remains plain text.");

    const inlineCode = await screen.findByText("artifact", { selector: "code" });
    expect(inlineCode).not.toHaveAttribute("role", "button");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
