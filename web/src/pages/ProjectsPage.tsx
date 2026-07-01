/**
 * Projects browse page (``/projects``).
 *
 * Lists every project with its icon, session count, and a preview of its
 * description ("Project instructions"). Clicking a project opens its detail
 * view (``/projects/:projectName``) where the description can be edited.
 *
 * Gated on ``functional_projects_enabled`` from ``/v1/info`` — the route
 * itself isn't registered when the flag is off (see ``App.tsx``), so reaching
 * this component already implies the feature is on. The extra in-component
 * guard is defence-in-depth: if the component is ever mounted with the flag
 * off, it renders the not-found page rather than calling the (disabled) API.
 *
 * Mirrors the information architecture of ``PoliciesPage`` / ``MembersPage``:
 * a ``PageScroll`` root, a header (title + subtitle), and a list with explicit
 * loading / empty / error states. Rebuilt with Omnigent's own components
 * (shadcn/ui + Tailwind v4) — it ports SP2K's ``ProjectView`` layout, not its
 * code.
 */

import { FolderIcon, RefreshCwIcon } from "lucide-react";
import { Link } from "@/lib/routing";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import { PageScroll } from "@/components/PageScroll";
import { Button } from "@/components/ui/button";
import { useProjectSummaries } from "@/hooks/useConversations";
import { NotFoundPage } from "./NotFoundPage";

/** Count label for a project row — hidden when the server reports no count. */
function sessionCountLabel(count: number | null): string | null {
  if (count === null) return null;
  return count === 1 ? "1 session" : `${count} sessions`;
}

export function ProjectsPage() {
  const info = useServerInfo();
  const {
    data: projects,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
  } = useProjectSummaries();

  // Defence-in-depth: the route is unregistered when the flag is off, but if
  // this ever mounts anyway, behave exactly like an unknown path.
  if (info !== "loading" && !info.functional_projects_enabled) {
    return <NotFoundPage />;
  }

  return (
    <PageScroll contentClassName="px-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Group related sessions and give each project standing instructions.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refetch()} disabled={isRefetching}>
          <RefreshCwIcon /> Refresh
        </Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {isError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Failed to load projects: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {!isLoading && !isError && projects && projects.length === 0 && (
        <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
          <FolderIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-medium">No projects yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            File a session under a project from the sidebar to create one.
          </p>
        </div>
      )}

      {!isLoading && !isError && projects && projects.length > 0 && (
        <ul className="flex flex-col gap-2">
          {projects.map((project) => {
            const count = sessionCountLabel(project.session_count);
            const description = project.description.trim();
            return (
              <li key={project.name}>
                <Link
                  to={`/projects/${encodeURIComponent(project.name)}`}
                  className="flex items-start gap-3 rounded-lg border border-border bg-background p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FolderIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{project.name}</span>
                      {count && (
                        <span className="shrink-0 text-xs text-muted-foreground">{count}</span>
                      )}
                    </div>
                    {description ? (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {description}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-xs text-muted-foreground/70 italic">
                        No project instructions
                      </p>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </PageScroll>
  );
}
