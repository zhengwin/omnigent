/**
 * Functional-projects API client.
 *
 * Thin wrappers around the project-metadata routes that back the
 * Projects page + per-project description ("Project instructions")
 * editor:
 *
 *   - ``GET  /v1/sessions/projects``          — list projects
 *   - ``GET  /v1/sessions/projects/{name}``   — project details
 *   - ``PUT  /v1/sessions/projects/{name}``   — upsert description/icon
 *
 * All new project UI is gated on ``functional_projects_enabled`` from
 * ``/v1/info`` (see ``lib/capabilities.ts``) — these helpers assume the
 * caller has already checked the flag.
 *
 * The list endpoint historically returned a bare ``string[]`` of names
 * (see ``useProjects`` in ``hooks/useConversations.ts``). The functional-
 * projects backend enriches it to carry per-project metadata, but the
 * exact wire shape must not be assumed: :func:`normalizeProjectSummary`
 * accepts BOTH a bare name string and the enriched object so the page
 * renders whether the server is old or new, and the existing sidebar's
 * ``string[]`` consumer keeps working unchanged.
 */

import { authenticatedFetch } from "./identity";

/** Per-project metadata as surfaced on the Projects list + detail views. */
export interface ProjectSummary {
  /** Project name — the primary key (matches the ``omni_project`` label value). */
  name: string;
  /** Project instructions injected as standing context. Empty string when unset. */
  description: string;
  /** Optional icon glyph/name; ``null`` when the project has no custom icon. */
  icon: string | null;
  /**
   * Number of (non-archived) sessions filed under this project. ``null`` when
   * the server doesn't report a count (e.g. a legacy list endpoint) — the UI
   * then omits the count rather than showing a misleading ``0``.
   */
  session_count: number | null;
}

/** Full project details returned by ``GET /v1/sessions/projects/{name}``. */
export interface ProjectDetails {
  name: string;
  description: string;
  icon: string | null;
  session_count: number | null;
}

/** Payload for ``PUT /v1/sessions/projects/{name}``. */
export interface UpdateProjectPayload {
  description: string;
  icon?: string | null;
}

/**
 * Coerce one entry from the project-list response into a {@link ProjectSummary}.
 *
 * Tolerates two shapes so the page is decoupled from the backend's exact
 * list contract:
 *   - a bare ``string`` (legacy list = ``string[]`` of names), and
 *   - an object ``{ name, description?, icon?, session_count? }``.
 *
 * Returns ``null`` for anything unrecognizable (or a nameless object) so a
 * single malformed row can't crash the list; callers filter these out.
 */
export function normalizeProjectSummary(entry: unknown): ProjectSummary | null {
  if (typeof entry === "string") {
    return { name: entry, description: "", icon: null, session_count: null };
  }
  if (entry !== null && typeof entry === "object") {
    const row = entry as Record<string, unknown>;
    // Accept `name`, falling back to `project` in case the backend names the
    // field differently — either way we need a non-empty string key.
    const name =
      typeof row.name === "string"
        ? row.name
        : typeof row.project === "string"
          ? row.project
          : null;
    if (!name) return null;
    const count =
      typeof row.session_count === "number"
        ? row.session_count
        : typeof row.count === "number"
          ? row.count
          : null;
    return {
      name,
      description: typeof row.description === "string" ? row.description : "",
      icon: typeof row.icon === "string" ? row.icon : null,
      session_count: count,
    };
  }
  return null;
}

/**
 * Fetch every project as a {@link ProjectSummary}, tolerating both the legacy
 * ``string[]`` list shape and the enriched object-array shape. Malformed rows
 * are dropped; results are sorted by name (case-insensitive) so the page has a
 * stable order regardless of server ordering.
 */
export async function fetchProjectSummaries(): Promise<ProjectSummary[]> {
  const res = await authenticatedFetch("/v1/sessions/projects");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const raw = (await res.json()) as unknown;
  const list = Array.isArray(raw) ? raw : [];
  const summaries = list
    .map(normalizeProjectSummary)
    .filter((p): p is ProjectSummary => p !== null);
  summaries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return summaries;
}

/**
 * Fetch a single project's details via ``GET /v1/sessions/projects/{name}``.
 *
 * Returns ``null`` on 404 so the detail page can show a "project not found"
 * empty state (e.g. after the project's last session is removed) rather than
 * erroring.
 */
export async function fetchProjectDetails(name: string): Promise<ProjectDetails | null> {
  const res = await authenticatedFetch(`/v1/sessions/projects/${encodeURIComponent(name)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = (await res.json()) as Record<string, unknown>;
  const count =
    typeof data.session_count === "number"
      ? data.session_count
      : typeof data.count === "number"
        ? data.count
        : null;
  return {
    name: typeof data.name === "string" ? data.name : name,
    description: typeof data.description === "string" ? data.description : "",
    icon: typeof data.icon === "string" ? data.icon : null,
    session_count: count,
  };
}

/**
 * Upsert a project's description (and optional icon) via
 * ``PUT /v1/sessions/projects/{name}``. Returns the server-confirmed details.
 */
export async function updateProject(
  name: string,
  payload: UpdateProjectPayload,
): Promise<ProjectDetails> {
  const res = await authenticatedFetch(`/v1/sessions/projects/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = (await res.json()) as Record<string, unknown>;
  const count =
    typeof data.session_count === "number"
      ? data.session_count
      : typeof data.count === "number"
        ? data.count
        : null;
  return {
    name: typeof data.name === "string" ? data.name : name,
    description: typeof data.description === "string" ? data.description : payload.description,
    icon: typeof data.icon === "string" ? data.icon : (payload.icon ?? null),
    session_count: count,
  };
}
