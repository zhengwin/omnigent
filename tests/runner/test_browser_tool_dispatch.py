"""Tests for the embedded-browser (``browser_*``) tool surface.

Covers the runner-side half of the feature:

- ``_execute_browser_tool``: the blocking ``server_client.post`` to the
  AP ``/browser/action_request`` route — correct URL / ``action`` /
  ``args`` payload, verbatim JSON passthrough, and the clean timeout
  error on ``httpx.ReadTimeout``.
- Registration in ``omnigent.tools.builtins``: the five ``browser_*``
  names are always registered.
- Native-relay exposure: ``build_native_relay_tool_schemas`` surfaces the
  five ``browser_*`` schemas when the spec declares them — native
  harnesses see the relay as their only tool surface, so a miss here
  means the feature is dead on the desktop app.
"""

from __future__ import annotations

import json

import httpx
import pytest

import omnigent.tools.builtins as builtins_mod
from omnigent.runner.tool_dispatch import (
    _BROWSER_TOOLS,
    _NATIVE_RELAY_BUILTIN_TOOLS,
    _execute_browser_tool,
    build_native_relay_tool_schemas,
)
from omnigent.spec.types import AgentSpec, BuiltinToolConfig, ToolsConfig

# ── Helpers ──────────────────────────────────────────────────────


class _RecordingResponse:
    """Minimal httpx response stub with a scripted body."""

    def __init__(self, *, status_code: int = 200, body: dict[str, object] | None = None) -> None:
        self.status_code = status_code
        self._body = body if body is not None else {}

    @property
    def text(self) -> str:
        """Return the JSON body as text (what the tool returns verbatim)."""
        return json.dumps(self._body)


class _RecordingClient:
    """httpx.AsyncClient stub that records the POST and returns a script."""

    def __init__(self, response: _RecordingResponse | None = None) -> None:
        self.calls: list[tuple[str, dict[str, object], object]] = []
        self._response = response or _RecordingResponse(body={"final_url": "https://x"})

    async def post(
        self,
        url: str,
        *,
        json: dict[str, object] | None = None,
        timeout: object = None,
    ) -> _RecordingResponse:
        """Record the call and return the scripted response."""
        self.calls.append((url, json or {}, timeout))
        return self._response


class _TimeoutClient:
    """httpx.AsyncClient stub whose POST raises ReadTimeout."""

    async def post(self, url: str, **_: object) -> _RecordingResponse:
        """Raise the read timeout the tool must translate to clean JSON."""
        raise httpx.ReadTimeout("read timed out")


class _ErrorClient:
    """httpx.AsyncClient stub whose POST raises a generic HTTPError."""

    async def post(self, url: str, **_: object) -> _RecordingResponse:
        """Raise a connect error the tool must surface as an error string."""
        raise httpx.ConnectError("connection refused")


# ── _execute_browser_tool ────────────────────────────────────────


@pytest.mark.asyncio
async def test_browser_tool_posts_action_request_with_stripped_prefix() -> None:
    """
    The tool POSTs to the action_request route with ``action`` = tool
    name minus ``browser_`` and forwards ``args`` verbatim.
    """
    client = _RecordingClient(_RecordingResponse(body={"final_url": "https://example.com"}))
    out = await _execute_browser_tool(
        "browser_navigate",
        {"url": "https://example.com"},
        server_client=client,
        conversation_id="conv_abc",
    )

    assert len(client.calls) == 1
    url, body, timeout = client.calls[0]
    assert url == "/v1/sessions/conv_abc/browser/action_request"
    assert body == {"action": "navigate", "args": {"url": "https://example.com"}}
    # read budget MUST exceed the AP await (30s) so the runner never
    # severs the still-open POST first.
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.read == 60.0
    # Result is the AP JSON verbatim.
    assert json.loads(out) == {"final_url": "https://example.com"}


@pytest.mark.asyncio
async def test_browser_tool_strips_prefix_for_every_action() -> None:
    """Each of the five tools maps to the correct wire ``action``."""
    expected = {
        "browser_navigate": "navigate",
        "browser_snapshot": "snapshot",
        "browser_click": "click",
        "browser_type": "type",
        "browser_screenshot": "screenshot",
    }
    for tool_name, action in expected.items():
        client = _RecordingClient()
        await _execute_browser_tool(
            tool_name, {}, server_client=client, conversation_id="conv_x"
        )
        assert client.calls[0][1]["action"] == action


@pytest.mark.asyncio
async def test_browser_tool_read_timeout_returns_clean_json() -> None:
    """
    A runner-side ``httpx.ReadTimeout`` becomes the clean timeout-error
    JSON, not an exception — so the LLM sees an actionable tool error.
    """
    out = await _execute_browser_tool(
        "browser_snapshot",
        {},
        server_client=_TimeoutClient(),
        conversation_id="conv_abc",
    )
    parsed = json.loads(out)
    assert "timed out" in parsed["error"]
    assert "Omnigent desktop app" in parsed["error"]


@pytest.mark.asyncio
async def test_browser_tool_http_error_returns_error_json() -> None:
    """A generic HTTP error is surfaced as an error JSON, not raised."""
    out = await _execute_browser_tool(
        "browser_click",
        {"ref": 3},
        server_client=_ErrorClient(),
        conversation_id="conv_abc",
    )
    parsed = json.loads(out)
    assert "browser_click failed" in parsed["error"]


@pytest.mark.asyncio
async def test_browser_tool_4xx_returns_error_json() -> None:
    """A >=400 response body is reported as an error string, not raised."""
    client = _RecordingClient(_RecordingResponse(status_code=403, body={"detail": "nope"}))
    out = await _execute_browser_tool(
        "browser_type",
        {"text": "hi"},
        server_client=client,
        conversation_id="conv_abc",
    )
    parsed = json.loads(out)
    assert "browser_type returned 403" in parsed["error"]


@pytest.mark.asyncio
async def test_browser_tool_requires_server_and_session() -> None:
    """Missing server_client or conversation_id fails loud with JSON."""
    out_no_client = await _execute_browser_tool(
        "browser_navigate", {"url": "u"}, server_client=None, conversation_id="conv"
    )
    assert "requires server access" in json.loads(out_no_client)["error"]

    out_no_conv = await _execute_browser_tool(
        "browser_navigate",
        {"url": "u"},
        server_client=_RecordingClient(),
        conversation_id=None,
    )
    assert "requires a session id" in json.loads(out_no_conv)["error"]


# ── Registration (always on) ─────────────────────────────────────

_EXPECTED_BROWSER_NAMES = {
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_screenshot",
}


def test_registration_always_includes_five_tools() -> None:
    """All five schema-valid ``browser_*`` tools are always registered."""
    browser = {n for n in builtins_mod.BUILTIN_NAMES if n.startswith("browser_")}
    assert browser == _EXPECTED_BROWSER_NAMES
    # They are user-enablable (have a factory), so they're instantiable.
    assert _EXPECTED_BROWSER_NAMES.issubset(builtins_mod.INSTANTIABLE_BUILTINS)
    for name in sorted(browser):
        tool = builtins_mod.get_builtin_tool(name)
        assert tool is not None
        schema = tool.get_schema()
        assert schema["function"]["name"] == name
        assert schema["function"]["description"]


# ── Native-relay exposure ────────────────────────────────────────


def test_browser_tools_in_native_relay_union() -> None:
    """The relay builtin union must include every browser tool name."""
    assert _BROWSER_TOOLS <= _NATIVE_RELAY_BUILTIN_TOOLS


def _browser_spec() -> AgentSpec:
    """Build a spec that declares all five browser builtins."""
    return AgentSpec(
        spec_version=1,
        tools=ToolsConfig(
            builtins=[
                BuiltinToolConfig(name="browser_navigate"),
                BuiltinToolConfig(name="browser_snapshot"),
                BuiltinToolConfig(name="browser_click"),
                BuiltinToolConfig(name="browser_type"),
                BuiltinToolConfig(name="browser_screenshot"),
            ]
        ),
    )


def test_native_relay_includes_browser_for_browser_spec() -> None:
    """
    A browser-enabled spec → all five ``browser_*`` schemas ride the
    native relay (required: the desktop app runs native sessions, which
    ignore ``request.tools`` and see only the relay surface).
    """
    schemas = build_native_relay_tool_schemas(_browser_spec())
    names = {s["name"] for s in schemas if s["name"].startswith("browser_")}
    assert names == _EXPECTED_BROWSER_NAMES
    # Each relay entry is the flat {name, description, parameters} shape.
    for schema in schemas:
        if schema["name"].startswith("browser_"):
            assert schema["description"]
            assert schema["parameters"]["type"] == "object"


def test_native_relay_omits_browser_when_spec_does_not_declare_them() -> None:
    """
    A spec that does NOT declare the browser builtins gets no
    ``browser_*`` schemas — the relay still filters by the spec's
    ToolManager surface, so unconditional registration doesn't force the
    tools onto every session.
    """
    schemas = build_native_relay_tool_schemas(AgentSpec(spec_version=1))
    assert not any(s["name"].startswith("browser_") for s in schemas)
