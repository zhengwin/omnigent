// Tests for the functional-projects browse page (ProjectsPage).
//
// The page is flag-gated (functional_projects_enabled) and driven by the
// react-query `useProjectSummaries` hook. Both are mocked so no QueryClient or
// network is needed — the surface under test is: flag gating, enriched-row
// rendering (description + session count), and the empty state.

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsPage } from "./ProjectsPage";
import * as capabilities from "@/lib/CapabilitiesContext";
import * as conversations from "@/hooks/useConversations";
import type { ProjectSummary } from "@/lib/projectsApi";

vi.mock("@/lib/CapabilitiesContext", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/CapabilitiesContext")>()),
  useServerInfo: vi.fn(),
}));
vi.mock("@/hooks/useConversations", () => ({ useProjectSummaries: vi.fn() }));

function setFlag(enabled: boolean) {
  vi.mocked(capabilities.useServerInfo).mockReturnValue(
    enabled
      ? ({ functional_projects_enabled: true } as never)
      : ({ functional_projects_enabled: false } as never),
  );
}

function setSummaries(
  data: ProjectSummary[] | undefined,
  overrides: Partial<Record<string, unknown>> = {},
) {
  vi.mocked(conversations.useProjectSummaries).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    isRefetching: false,
    ...overrides,
  } as never);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ProjectsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setFlag(true);
  setSummaries([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectsPage gating", () => {
  it("renders the not-found page when the flag is off", () => {
    setFlag(false);
    renderPage();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
  });
});

describe("ProjectsPage list", () => {
  it("shows the empty state when there are no projects", () => {
    renderPage();
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });

  it("renders enriched rows with description preview and session count", () => {
    setSummaries([
      {
        name: "alpha-service",
        description: "Prefer TypeScript. Always add tests.",
        icon: null,
        session_count: 3,
      },
      { name: "billing-refactor", description: "", icon: null, session_count: 1 },
    ]);
    renderPage();

    // Names + a description preview from the enriched object row.
    expect(screen.getByText("alpha-service")).toBeInTheDocument();
    expect(screen.getByText("Prefer TypeScript. Always add tests.")).toBeInTheDocument();
    // Session counts, singular vs plural.
    expect(screen.getByText("3 sessions")).toBeInTheDocument();
    expect(screen.getByText("1 session")).toBeInTheDocument();
    // A project with no description shows the placeholder, not an empty preview.
    expect(screen.getByText("No project instructions")).toBeInTheDocument();
    // Rows link to the detail route.
    expect(screen.getByRole("link", { name: /alpha-service/ })).toHaveAttribute(
      "href",
      "/projects/alpha-service",
    );
  });

  it("omits the session count when the server reports none (legacy list)", () => {
    setSummaries([{ name: "legacy", description: "", icon: null, session_count: null }]);
    renderPage();
    expect(screen.getByText("legacy")).toBeInTheDocument();
    // The "<n> session(s)" count label is omitted (the subtitle also mentions
    // "sessions", so match the count-label shape specifically).
    expect(screen.queryByText(/^\d+\s+sessions?$/)).not.toBeInTheDocument();
  });
});
