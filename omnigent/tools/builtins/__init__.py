"""Built-in tools for omnigent.

Public API:
- ``LoadSkillTool``: Loads a skill's instructions by name.
- ``ReadSkillFileTool``: Reads files from a skill's directory.
- ``any_skill_has_resources``: Checks if any skill has bundled
  resource files (used by ToolManager to decide whether to
  register ReadSkillFileTool).
- ``list_skill_resources``: Lists resource files in a skill's
  directory (used by LoadSkillTool to append file listings).
- ``format_skill_content``: Formats a skill's content for the LLM,
  appending a resource file listing if present.
- ``find_skill_by_name``: Looks up a skill by exact name in a
  merged (bundled + host) skill list.
- ``format_skill_meta_text``: Builds the hidden ``<skill>`` wrapper
  text injected when a slash command invokes a skill (resolved on
  the runner, where ``skill_dir`` paths are valid).
- ``get_builtin_tool``: Instantiate a built-in tool by name.
"""

from __future__ import annotations

import os
from collections.abc import Callable

from omnigent.spec.types import SkillSpec
from omnigent.tools.base import Tool
from omnigent.tools.builtins.advise_models import SysAdviseModelsTool
from omnigent.tools.builtins.agents import (
    SysAgentDownloadTool,
    SysAgentGetTool,
    SysAgentListTool,
)
from omnigent.tools.builtins.async_inbox import (
    SysCallAsyncTool,
    SysCancelAsyncTool,
    SysReadInboxTool,
)
from omnigent.tools.builtins.list_comments import ListCommentsTool
from omnigent.tools.builtins.list_models import SysListModelsTool
from omnigent.tools.builtins.load_skill import (
    LoadSkillTool,
    find_skill_by_name,
    format_skill_content,
    format_skill_meta_text,
    list_skill_resources,
)
from omnigent.tools.builtins.read_skill_file import (
    ReadSkillFileTool,
)
from omnigent.tools.builtins.spawn import (
    SysSessionCloseTool,
    SysSessionCreateTool,
    SysSessionGetHistoryTool,
    SysSessionGetInfoTool,
    SysSessionListTool,
    SysSessionSendTool,
    SysSessionShareTool,
)
from omnigent.tools.builtins.timer import (
    SysTimerCancelTool,
    SysTimerSetTool,
)
from omnigent.tools.builtins.update_comment import UpdateCommentTool
from omnigent.tools.builtins.web_search import WebSearchTool

__all__ = [
    "BUILTIN_NAMES",
    "INSTANTIABLE_BUILTINS",
    "ListCommentsTool",
    "LoadSkillTool",
    "ReadSkillFileTool",
    "SysAdviseModelsTool",
    "SysAgentDownloadTool",
    "SysAgentGetTool",
    "SysAgentListTool",
    "SysCallAsyncTool",
    "SysCancelAsyncTool",
    "SysListModelsTool",
    "SysReadInboxTool",
    "SysSessionCloseTool",
    "SysSessionCreateTool",
    "SysSessionGetHistoryTool",
    "SysSessionGetInfoTool",
    "SysSessionListTool",
    "SysSessionSendTool",
    "SysSessionShareTool",
    "SysTimerCancelTool",
    "SysTimerSetTool",
    "UpdateCommentTool",
    "WebSearchTool",
    "any_skill_has_resources",
    "find_skill_by_name",
    "format_skill_content",
    "format_skill_meta_text",
    "get_builtin_tool",
    "list_skill_resources",
]

# Lazy imports avoid circular import cycles — each tool's actual
# class is imported only when the factory fires.

# Factory type: each constructor accepts a config dict and returns
# a Tool. Callable is used instead of type[Tool] because the base
# Tool.__init__ does not declare a config parameter — only the
# web search subclasses do.
_BuiltinFactory = Callable[[dict[str, str]], Tool]


def _create_upload_file(config: dict[str, str]) -> Tool:
    """
    Lazy factory for UploadFileTool.

    :param config: Tool config (unused).
    :returns: An UploadFileTool instance.
    """
    from omnigent.tools.builtins.upload_file import UploadFileTool

    return UploadFileTool()


def _create_search_conversations(config: dict[str, str]) -> Tool:
    """
    Lazy factory for SearchConversationsTool.

    :param config: Tool config (unused).
    :returns: A SearchConversationsTool instance.
    """
    from omnigent.tools.builtins.search_conversations import (
        SearchConversationsTool,
    )

    return SearchConversationsTool()


def _create_list_files(config: dict[str, str]) -> Tool:
    """
    Lazy factory for ListFilesTool.

    :param config: Tool config (unused).
    :returns: A ListFilesTool instance.
    """
    from omnigent.tools.builtins.list_files import ListFilesTool

    return ListFilesTool()


def _create_download_file(config: dict[str, str]) -> Tool:
    """
    Lazy factory for DownloadFileTool.

    :param config: Tool config (unused).
    :returns: A DownloadFileTool instance.
    """
    from omnigent.tools.builtins.download_file import DownloadFileTool

    return DownloadFileTool()


def _create_export_agent(config: dict[str, str]) -> Tool:
    """
    Lazy factory for ExportAgentTool.

    :param config: Tool config (unused).
    :returns: An ExportAgentTool instance.
    """
    from omnigent.tools.builtins.export_agent import ExportAgentTool

    return ExportAgentTool()


# Feature flag gating the embedded-browser tools. Truthy env value
# (anything non-empty other than the usual falsey strings) opts a
# deployment into advertising the five ``browser_*`` tools. Unset —
# the default — keeps the builtin registry, ``BUILTIN_NAMES``, and
# ``INSTANTIABLE_BUILTINS`` byte-for-byte identical to before this
# feature landed (design Task 7: zero-diff default).
_BROWSER_TOOLS_FLAG = "OMNIGENT_BROWSER_TOOLS"
_BROWSER_FALSEY = frozenset({"", "0", "false", "no", "off"})


def _browser_tools_enabled() -> bool:
    """
    Whether the embedded-browser builtins should be registered.

    :returns: ``True`` when ``OMNIGENT_BROWSER_TOOLS`` is set to a
        truthy value; ``False`` (the default) otherwise.
    """
    return os.getenv(_BROWSER_TOOLS_FLAG, "").strip().lower() not in _BROWSER_FALSEY


def _make_browser_factory(tool_name: str) -> _BuiltinFactory:
    """
    Build a lazy factory for one schema-only ``browser_*`` tool class.

    Execution of the tool lives in the runner dispatch layer
    (``omnigent/runner/tool_dispatch.py``); the class returned here is
    schema surface only (``name`` / ``description`` / ``get_schema``).

    :param tool_name: One of the five ``browser_*`` names.
    :returns: A factory that constructs the matching Tool subclass.
    """

    def factory(config: dict[str, str]) -> Tool:
        # Import lazily so the module only loads when the flag is on.
        from omnigent.tools.builtins.browser import (
            BrowserClickTool,
            BrowserNavigateTool,
            BrowserScreenshotTool,
            BrowserSnapshotTool,
            BrowserTypeTool,
        )

        by_name: dict[str, type[Tool]] = {
            BrowserNavigateTool.name(): BrowserNavigateTool,
            BrowserSnapshotTool.name(): BrowserSnapshotTool,
            BrowserClickTool.name(): BrowserClickTool,
            BrowserTypeTool.name(): BrowserTypeTool,
            BrowserScreenshotTool.name(): BrowserScreenshotTool,
        }
        return by_name[tool_name]()

    return factory


# Unified registry for every reserved builtin name. The value
# is either a factory callable (for user-enablable tools) or
# ``None`` for framework-owned names that occupy the name-space
# but are never instantiated by user spec directives.
# See POLICIES.md §15.8 for the unification rationale.
#
# Note: the legacy ``terminal_run`` / ``terminal_list`` /
# ``terminal_close`` / ``terminal_send_input`` family was deleted
# per ``designs/OMNIGENT_TERMINAL_BRIDGE.md`` §3a + §6.2. Their
# replacement is the ``sys_terminal_*`` family registered
# automatically by ``ToolManager._register_terminal_tools`` when
# the spec declares a ``terminals:`` block — not via this
# registry. One-shot shell commands now use ``sys_os_shell``
# instead.
_BUILTIN_REGISTRY: dict[str, _BuiltinFactory | None] = {
    # User-enablable tools (factory present).
    "web_search": lambda config: WebSearchTool(config=config),
    "upload_file": _create_upload_file,
    "list_files": _create_list_files,
    "download_file": _create_download_file,
    "search_conversations": _create_search_conversations,
    "export_agent": _create_export_agent,
    # Framework-owned: need runtime context. ``web_fetch`` is
    # constructed by ToolManager before reaching this registry.
    # ``list_comments`` and ``update_comment`` are auto-registered by
    # ``ToolManager._register_comment_tools`` — they are reserved
    # here so user specs cannot shadow them. (Policy ASKs are
    # surfaced as MCP-shape elicitations on the SSE stream — not
    # via the tool registry — see omnigent/runtime/policies/approval.py.)
    "web_fetch": None,
    "list_comments": None,
    "update_comment": None,
    # ``sys_list_models`` is auto-registered by
    # ``ToolManager._register_sub_agent_tools`` with the dispatch grant
    # and intercepted by name in the runner's tool dispatch — reserved
    # here so user specs cannot shadow it.
    "sys_list_models": None,
    # ``sys_advise_models`` is auto-registered alongside ``sys_list_models``
    # when ``RuntimeCaps.routing_client`` is configured. Intercepted by
    # name in the runner's tool dispatch — reserved here so user specs
    # cannot shadow it.
    "sys_advise_models": None,
}

# Flag-gated embedded-browser tools. Registered ONLY when
# ``OMNIGENT_BROWSER_TOOLS`` is truthy so that, by default, the registry
# (and everything derived from it below) is unchanged — zero-diff
# behavior when the flag is unset (design Task 7). Each name maps to a
# factory that constructs its schema-only ``browser_*`` Tool subclass;
# execution lives in the runner dispatch ``_BROWSER_TOOLS`` branch.
if _browser_tools_enabled():
    for _browser_name in (
        "browser_navigate",
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_screenshot",
    ):
        _BUILTIN_REGISTRY[_browser_name] = _make_browser_factory(_browser_name)

# Canonical set of every reserved builtin name. Derived from
# the registry so there is a single source of truth — no drift
# between the reserved-name check and the factory dispatch.
BUILTIN_NAMES: frozenset[str] = frozenset(_BUILTIN_REGISTRY.keys())

# Subset of names that have a user-facing factory. Used by the
# onboarding ``list_builtin_tools`` helper, which only lists
# tools an agent spec can actually enable via
# ``tools.builtins`` — framework-owned names would just confuse
# the agent author.
INSTANTIABLE_BUILTINS: frozenset[str] = frozenset(
    name for name, factory in _BUILTIN_REGISTRY.items() if factory is not None
)


def get_builtin_tool(
    name: str,
    config: dict[str, str] | None = None,
) -> Tool | None:
    """
    Instantiate a built-in tool by name with optional config.

    :param name: The tool name from ``tools.builtins`` in
        config.yaml, e.g. ``"web_search"``.
    :param config: Tool-specific key-value pairs from the spec,
        e.g. ``{"api_key": "sk-...", "engine_id": "abc"}``.
        ``None`` or empty dict means no spec-level config was
        provided.
    :returns: A :class:`Tool` instance, or ``None`` if the
        name is not recognized.
    """
    # Returns None for both "not in registry" AND
    # "framework-owned without factory" — callers treat both
    # as "not instantiable via this entry point". Check against
    # BUILTIN_NAMES first if you need to distinguish.
    factory = _BUILTIN_REGISTRY.get(name)
    if factory is None:
        return None
    return factory(config or {})


def any_skill_has_resources(
    skills: list[SkillSpec],
) -> bool:
    """
    Check whether any skill has bundled resource files.

    :param skills: The agent's skill list, e.g.
        ``[SkillSpec(name="code-review", ...)]``.
    :returns: ``True`` if at least one skill has a
        ``skill_dir`` with files in references/, scripts/,
        or assets/.
    """
    return any(list_skill_resources(s) for s in skills)
