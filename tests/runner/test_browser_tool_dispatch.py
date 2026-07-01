"""Tests for the embedded-browser (``browser_*``) tool surface.

Covers the runner-side half of the feature:

- ``_execute_browser_tool``: the blocking ``server_client.post`` to the
  AP ``/browser/action_request`` route — correct URL / ``action`` /
  ``args`` payload, verbatim JSON passthrough, and the clean timeout
  error on ``httpx.ReadTimeout``.
- Flag-gated registration in ``omnigent.tools.builtins``: zero-diff when
  ``OMNIGENT_BROWSER_TOOLS`` is unset; all five names present when set.
- Native-relay exposure (the P1 fix): ``build_native_relay_tool_schemas``
  surfaces the five ``browser_*`` schemas ONLY when the flag is on and
  the spec declares them — native harnesses see the relay as their only
  tool surface, so a miss here means the feature is dead on the desktop
  app.

The flag is read at import time (static registry), so the flag tests
reload ``omnigent.tools.builtins`` under a patched environment and
reload it back to the default afterwards.
"""

from __future__ import annotations

import importlib
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


# ── Flag-gated registration (zero-diff default) ──────────────────


def _reload_builtins_with_flag(monkeypatch: pytest.MonkeyPatch, value: str | None) -> object:
    """
    Reload ``omnigent.tools.builtins`` with the flag set/unset.

    :param monkeypatch: Pytest monkeypatch fixture.
    :param value: Env value for ``OMNIGENT_BROWSER_TOOLS``; ``None``
        deletes it.
    :returns: The reloaded module.
    """
    if value is None:
        monkeypatch.delenv("OMNIGENT_BROWSER_TOOLS", raising=False)
    else:
        monkeypatch.setenv("OMNIGENT_BROWSER_TOOLS", value)
    return importlib.reload(builtins_mod)


@pytest.fixture(autouse=True)
def _restore_builtins_registry() -> object:
    """
    Reload the builtins module back to the ambient env after each test.

    The flag is read at import, and the module is process-global, so a
    test that reloads it under a patched env would otherwise leak the
    browser names into every later test in the worker.
    """
    yield
    importlib.reload(builtins_mod)


def test_registration_zero_diff_when_flag_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """Flag unset → no ``browser_*`` names in the registry (zero-diff)."""
    mod = _reload_builtins_with_flag(monkeypatch, None)
    assert not any(n.startswith("browser_") for n in mod.BUILTIN_NAMES)
    assert not any(n.startswith("browser_") for n in mod.INSTANTIABLE_BUILTINS)


def test_registration_adds_five_tools_when_flag_set(monkeypatch: pytest.MonkeyPatch) -> None:
    """Flag on → all five schema-valid ``browser_*`` tools registered."""
    mod = _reload_builtins_with_flag(monkeypatch, "1")
    browser = sorted(n for n in mod.BUILTIN_NAMES if n.startswith("browser_"))
    assert browser == [
        "browser_click",
        "browser_navigate",
        "browser_screenshot",
        "browser_snapshot",
        "browser_type",
    ]
    for name in browser:
        tool = mod.get_builtin_tool(name)
        assert tool is not None
        schema = tool.get_schema()
        assert schema["function"]["name"] == name
        assert schema["function"]["description"]


@pytest.mark.parametrize("falsey", ["", "0", "false", "no", "off"])
def test_registration_treats_falsey_values_as_off(
    monkeypatch: pytest.MonkeyPatch, falsey: str
) -> None:
    """Falsey flag values keep the tools unregistered (zero-diff)."""
    mod = _reload_builtins_with_flag(monkeypatch, falsey)
    assert not any(n.startswith("browser_") for n in mod.BUILTIN_NAMES)


# ── Native-relay exposure (the P1 fix) ───────────────────────────


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


def test_native_relay_excludes_browser_when_flag_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Flag unset → native relay surface has no ``browser_*`` schemas.

    Even a spec that names the builtins gets nothing, because the
    registry (read at import) never registered them — proving zero-diff
    for native harnesses.
    """
    _reload_builtins_with_flag(monkeypatch, None)
    schemas = build_native_relay_tool_schemas(_browser_spec())
    assert not any(s["name"].startswith("browser_") for s in schemas)


def test_native_relay_includes_browser_when_flag_set(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Flag on + browser-enabled spec → all five ``browser_*`` schemas ride
    the native relay (the P1 fix; without it the desktop app's native
    sessions never see the tools).
    """
    _reload_builtins_with_flag(monkeypatch, "1")
    schemas = build_native_relay_tool_schemas(_browser_spec())
    names = {s["name"] for s in schemas if s["name"].startswith("browser_")}
    assert names == {
        "browser_navigate",
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_screenshot",
    }
    # Each relay entry is the flat {name, description, parameters} shape.
    for schema in schemas:
        if schema["name"].startswith("browser_"):
            assert schema["description"]
            assert schema["parameters"]["type"] == "object"
