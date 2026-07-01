/**
 * Project detail view (``/projects/:projectName``).
 *
 * The user-facing home of a project's *standing context*: the header shows the
 * project name + icon, an editable **description** ("Project instructions")
 * that the backend injects into every session under this project, and the list
 * of the project's sessions.
 *
 * Ports the information architecture of SP2K's ``ProjectView`` — header with an
 * editable instructions block, then the session list — rebuilt with Omnigent's
 * own components (shadcn/ui + Tailwind v4). Gated on
 * ``functional_projects_enabled``; the route is unregistered when the flag is
 * off (see ``App.tsx``), and the in-component guard is defence-in-depth.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon, FolderIcon } from "lucide-react";
import { Link, useNavigate, useParams } from "@/lib/routing";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import { PageScroll } from "@/components/PageScroll";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useProjectDetails,
  useProjectSessions,
  useUpdateProjectDescription,
  type Conversation,
} from "@/hooks/useConversations";
import { conversationDisplayLabel } from "@/shell/sidebarNav";
import { relativeTime } from "@/lib/relativeTime";
import { NotFoundPage } from "./NotFoundPage";

/** One session row in the project's session list. */
function ProjectSessionRow({ conversation }: { conversation: Conversation }) {
  const label = conversationDisplayLabel(conversation);
  return (
    <li>
      <Link
        to={`/c/${conversation.id}`}
        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 truncate text-sm">{label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {relativeTime(conversation.updated_at * 1000)}
        </span>
      </Link>
    </li>
  );
}

/**
 * The editable "Project instructions" block: a textarea seeded from the saved
 * description, a Save button that PUTs the new value, and inline saving /
 * success / error states. Dirty-tracks against the last saved value so Save is
 * disabled when there's nothing to persist.
 */
function DescriptionEditor({ name, savedDescription }: { name: string; savedDescription: string }) {
  const [draft, setDraft] = useState(savedDescription);
  const [justSaved, setJustSaved] = useState(false);
  const update = useUpdateProjectDescription();

  // Re-seed the draft when the saved value changes from underneath us (e.g. a
  // refetch landed a newer description), but only while the user hasn't started
  // editing — never clobber in-progress edits.
  useEffect(() => {
    setDraft(savedDescription);
  }, [savedDescription]);

  const dirty = draft !== savedDescription;

  function onSave() {
    setJustSaved(false);
    update.mutate({ name, description: draft }, { onSuccess: () => setJustSaved(true) });
  }

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium">Project instructions</h2>
        <div className="flex items-center gap-3">
          {update.isSuccess && justSaved && !dirty && (
            <span className="text-xs text-muted-foreground">Saved</span>
          )}
          <Button size="sm" onClick={onSave} disabled={!dirty || update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        Applied as standing context to every session in this project.
      </p>
      <Textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (justSaved) setJustSaved(false);
        }}
        rows={6}
        placeholder="e.g. Always write tests. Prefer TypeScript. The API base URL is…"
        aria-label="Project instructions"
      />
      {update.isError && (
        <div
          role="alert"
          className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Couldn't save:{" "}
          {update.error instanceof Error ? update.error.message : String(update.error)}
        </div>
      )}
    </section>
  );
}

export function ProjectDetailPage() {
  const info = useServerInfo();
  const navigate = useNavigate();
  const { projectName } = useParams<{ projectName: string }>();
  const name = projectName ? decodeURIComponent(projectName) : "";

  const flagOn = info === "loading" || info.functional_projects_enabled;
  const { data: details, isLoading: detailsLoading } = useProjectDetails(name, flagOn);
  // Reuse the sidebar's project-sessions pagination — server-side `?project=`
  // filtered, newest-first.
  const sessionsQuery = useProjectSessions(name, flagOn && name.length > 0);
  const sessions = useMemo(
    () => sessionsQuery.data?.pages.flatMap((page) => page.data) ?? [],
    [sessionsQuery.data],
  );

  // Defence-in-depth: mirror the not-found path when the flag is off.
  if (info !== "loading" && !info.functional_projects_enabled) {
    return <NotFoundPage />;
  }

  return (
    <PageScroll contentClassName="px-6">
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          className="mb-3 -ml-2 text-muted-foreground"
          onClick={() => navigate("/projects")}
        >
          <ArrowLeftIcon /> All projects
        </Button>
        <div className="flex items-center gap-3">
          <FolderIcon className="size-6 shrink-0 text-muted-foreground" />
          <h1 className="min-w-0 truncate text-2xl font-semibold">{name}</h1>
        </div>
      </div>

      {detailsLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {/* A 404 from details (project has no metadata row / no sessions) still
          lets the user set instructions — treat a null/empty description as an
          empty editor rather than an error, so the editor always renders. */}
      {!detailsLoading && (
        <DescriptionEditor name={name} savedDescription={details?.description ?? ""} />
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium">Sessions</h2>
        {sessionsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : sessionsQuery.isError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            Failed to load sessions.
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sessions in this project yet.</p>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {sessions.map((conversation) => (
                <ProjectSessionRow key={conversation.id} conversation={conversation} />
              ))}
            </ul>
            {sessionsQuery.hasNextPage && (
              <div className="mt-3 flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void sessionsQuery.fetchNextPage()}
                  disabled={sessionsQuery.isFetchingNextPage}
                >
                  {sessionsQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </PageScroll>
  );
}
