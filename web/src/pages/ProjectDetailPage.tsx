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

import { useEffect, useMemo, useRef, useState } from "react";
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

/**
 * Client-side cap on the description length, mirroring the backend's
 * `ProjectUpdateRequest.description` `max_length` so users get immediate
 * feedback (counter + hard maxlength) instead of a 422 after Save.
 */
const DESCRIPTION_MAX_LENGTH = 8000;

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

  // The last value we know the server holds. Tracked in a ref so the re-seed
  // effect can compare against it WITHOUT re-running when `draft` changes —
  // its only dependency is `savedDescription`.
  const savedRef = useRef(savedDescription);
  const dirty = draft !== savedRef.current;

  // Re-seed the draft when the saved value changes from underneath us (e.g. a
  // background refetch landed a newer description), but ONLY while the draft is
  // not dirty — otherwise a refetch would clobber the user's in-progress edits.
  // Reading `dirty` from a ref-derived comparison keeps this effect off the
  // `draft` dependency, so typing never re-triggers it.
  useEffect(() => {
    if (draft === savedRef.current) {
      // Not dirty (draft matches the previously-saved value): adopt the new
      // server value.
      setDraft(savedDescription);
    }
    savedRef.current = savedDescription;
    // Intentionally excludes `draft`: we snapshot dirtiness via `savedRef` at
    // effect time and must not re-run on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedDescription]);

  function onSave() {
    setJustSaved(false);
    update.mutate(
      { name, description: draft },
      {
        onSuccess: (updated) => {
          // Anchor the saved baseline to what the server confirmed so `dirty`
          // flips false immediately (before the details refetch lands).
          savedRef.current = updated.description;
          setJustSaved(true);
        },
      },
    );
  }

  const overLimit = draft.length > DESCRIPTION_MAX_LENGTH;

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium">Project instructions</h2>
        <div className="flex items-center gap-3">
          {update.isSuccess && justSaved && !dirty && (
            <span className="text-xs text-muted-foreground">Saved</span>
          )}
          <Button size="sm" onClick={onSave} disabled={!dirty || overLimit || update.isPending}>
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
        maxLength={DESCRIPTION_MAX_LENGTH}
        placeholder="e.g. Always write tests. Prefer TypeScript. The API base URL is…"
        aria-label="Project instructions"
      />
      <div className="mt-1 text-right text-xs text-muted-foreground tabular-nums">
        {draft.length.toLocaleString()} / {DESCRIPTION_MAX_LENGTH.toLocaleString()}
      </div>
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
  // React Router already URL-decodes path params, so `projectName` is the
  // decoded name — do NOT decode again (a literal `%` would throw URIError and
  // `%2F` would wrongly become `/`, addressing a different project).
  const { projectName } = useParams<{ projectName: string }>();
  const name = projectName ?? "";

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

  // `useProjectDetails` resolves to `null` only on a genuine 404 (no metadata
  // row AND, with the ACL fix, no session the viewer can access). An implicit
  // project — sessions filed under a label with no metadata row yet — still has
  // sessions, so it's editable. Only when BOTH the details 404 AND there are no
  // accessible sessions do we treat the project as not-found. Wait for both
  // queries to settle so we don't flash not-found mid-load.
  const settled = !detailsLoading && !sessionsQuery.isLoading;
  const notFound = settled && details === null && sessions.length === 0;

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

      {!settled && <p className="text-sm text-muted-foreground">Loading…</p>}

      {/* True 404: no metadata row and no session the viewer can access. Show a
          not-found state rather than an editable form the backend PUT would
          reject. */}
      {notFound && (
        <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
          <p className="text-sm font-medium">Project not found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            This project doesn't exist or you don't have access to it.
          </p>
        </div>
      )}

      {/* Editor renders for a real project — one with a metadata row OR at least
          one accessible session (an implicit, label-only project). A null
          description just seeds an empty editor. */}
      {settled && !notFound && (
        <DescriptionEditor name={name} savedDescription={details?.description ?? ""} />
      )}

      {settled && !notFound && (
        <section>
          <h2 className="mb-2 text-sm font-medium">Sessions</h2>
          {sessionsQuery.isError ? (
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
      )}
    </PageScroll>
  );
}
