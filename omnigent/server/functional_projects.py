"""Feature flag + prompt rendering for functional projects.

"Functional projects" turns an Omnigent project's description into standing
context: when a session is filed under a project that has a non-empty
description, that description is injected as a ``<project_instructions>``
block into the session's system prompt on every turn (see the injection
seam in ``omnigent/server/routes/sessions.py::_forward_event_to_runner``).

Gated behind the ``OMNIGENT_FUNCTIONAL_PROJECTS`` env var (``"1"`` to
enable), following the repo's ``OMNIGENT_<FEATURE>`` convention
(cf. ``OMNIGENT_NO_SPINNER``). Flag off ⇒ nothing is injected and the
write route 404s, so prompt output and DB behaviour are byte-identical to
a build without this feature.
"""

from __future__ import annotations

import os

from omnigent.server.auth import RESERVED_USER_LOCAL

# Env var that enables the feature. Read live (not cached at import) so a
# test / deployment can toggle it via the environment without a restart —
# matches how the rest of the OMNIGENT_* flags are consulted.
FUNCTIONAL_PROJECTS_ENV_VAR = "OMNIGENT_FUNCTIONAL_PROJECTS"

# One-line preamble prepended to the injected block, mirroring SP2K's
# "Project instructions" framing so the model treats the description as
# standing context rather than a user turn.
_PREAMBLE = (
    "The user has set the following project instructions. They apply to "
    "every session in this project — honor them as standing context for "
    "this task."
)


def functional_projects_enabled() -> bool:
    """
    Return whether the functional-projects feature is enabled.

    :returns: ``True`` iff ``OMNIGENT_FUNCTIONAL_PROJECTS == "1"``.
    """
    return os.environ.get(FUNCTIONAL_PROJECTS_ENV_VAR) == "1"


def project_owner(user_id: str | None) -> str:
    """
    Normalize an auth identity into the ``projects.owner`` key.

    Project metadata is owner-scoped, but ``require_user`` /
    ``get_session_owner`` return ``None`` in single-user / no-auth mode.
    Map that to the reserved ``"local"`` sentinel so a single-user
    deployment has a stable, non-null owner key (all its projects share
    one owner), while multi-user deployments key on the real user id.

    :param user_id: The authenticated user id, or ``None`` (no auth /
        single-user, or a session with no real owner grant).
    :returns: The owner key: the user id, or ``"local"`` when ``None``.
    """
    return user_id if user_id is not None else RESERVED_USER_LOCAL


def render_project_instructions(description: str) -> str:
    """
    Render a project description as a labeled standing-context block.

    :param description: The project's instruction text. Callers must only
        pass a non-empty, stripped description — an empty description
        means "no injection" and must never reach here (that is the
        zero-diff default).
    :returns: The ``<project_instructions>`` block, preamble + description.
    """
    return f"<project_instructions>\n{_PREAMBLE}\n\n{description}\n</project_instructions>"
