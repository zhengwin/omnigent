"""Focused tests for payload-free retry readiness reconciliation."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import ANY, AsyncMock

import pytest

from omnigent.entities import ErrorData
from omnigent.entities.conversation import Conversation
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.routes import sessions as sessions_module
from omnigent.server.routes._sessions.helpers import _NativeTerminalEnsureOutcome
from omnigent.server.routes._sessions.orchestration import (
    _reconcile_retry_session_readiness,
)


def _conv(**kwargs: Any) -> Conversation:
    base = {
        "id": "conv_1",
        "created_at": 1,
        "updated_at": 1,
        "root_conversation_id": "conv_1",
        "agent_id": "agent_1",
    }
    base.update(kwargs)
    return Conversation(**base)


def _native_conv(**kwargs: Any) -> Conversation:
    key = sessions_module._CLAUDE_NATIVE_WRAPPER_LABEL_KEY
    value = sessions_module._CLAUDE_NATIVE_WRAPPER_LABEL_VALUE
    return _conv(labels={key: value}, **kwargs)


class _Store:
    def __init__(self, conv: Conversation) -> None:
        self._conv = conv

    def get_conversation(self, conversation_id: str) -> Conversation:
        assert conversation_id == self._conv.id
        return self._conv


@pytest.mark.asyncio
async def test_live_non_native_runner_is_an_honest_noop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner_client = object()
    conv = _conv(runner_id="runner_live")
    monkeypatch.setattr(
        sessions_module,
        "_get_runner_client",
        AsyncMock(return_value=runner_client),
    )
    ensure_connected = AsyncMock()
    monkeypatch.setattr(sessions_module, "ensure_runner_connected", ensure_connected)

    outcome = await _reconcile_retry_session_readiness(
        session_id=conv.id,
        app_state=SimpleNamespace(),
        conversation_store=_Store(conv),
        runner_router=None,
    )

    assert outcome == sessions_module._RetrySessionReadiness(
        recovered=False,
        recovery="already_connected",
    )
    ensure_connected.assert_not_awaited()


@pytest.mark.asyncio
async def test_live_native_runner_ensures_terminal_without_persisting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner_client = object()
    conv = _native_conv(runner_id="runner_live")
    monkeypatch.setattr(
        sessions_module,
        "_get_runner_client",
        AsyncMock(return_value=runner_client),
    )
    ensure_terminal = AsyncMock(return_value=_NativeTerminalEnsureOutcome(error=None))
    relay_ready = AsyncMock(return_value=None)
    monkeypatch.setattr(sessions_module, "_ensure_native_terminal_ready", ensure_terminal)
    monkeypatch.setattr(sessions_module, "_ensure_runner_relay_ready", relay_ready)

    outcome = await _reconcile_retry_session_readiness(
        session_id=conv.id,
        app_state=SimpleNamespace(),
        conversation_store=_Store(conv),
        runner_router=None,
    )

    assert outcome == sessions_module._RetrySessionReadiness(
        recovered=True,
        recovery="native_terminal_ready",
    )
    ensure_terminal.assert_awaited_once_with(
        runner_client,
        conv.id,
        conv,
        persist_resource_event=False,
    )
    relay_ready.assert_awaited_once_with(
        conv.id,
        conv.runner_id,
        runner_client,
        ANY,
    )


@pytest.mark.asyncio
async def test_dead_runner_initializes_and_reports_actual_relaunch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = _conv(runner_id="runner_dead")
    relaunched = _conv(runner_id="runner_new")
    runner_client = object()
    initializer = object()
    store = _Store(original)
    monkeypatch.setattr(
        sessions_module,
        "_get_runner_client",
        AsyncMock(return_value=None),
    )
    ensure_connected = AsyncMock(return_value=(runner_client, relaunched))
    initialize = AsyncMock(return_value=False)
    relay_ready = AsyncMock(return_value=None)
    monkeypatch.setattr(sessions_module, "ensure_runner_connected", ensure_connected)
    monkeypatch.setattr(sessions_module, "_ensure_runner_session_initialized", initialize)
    monkeypatch.setattr(sessions_module, "_ensure_runner_relay_ready", relay_ready)

    outcome = await _reconcile_retry_session_readiness(
        session_id=original.id,
        app_state=SimpleNamespace(runner_session_initializer=initializer),
        conversation_store=store,
        runner_router=None,
    )

    assert outcome == sessions_module._RetrySessionReadiness(
        recovered=True,
        recovery="runner_relaunched",
    )
    ensure_connected.assert_awaited_once_with(
        session_id=original.id,
        conv=original,
        app_state=ANY,
        conversation_store=store,
        runner_router=None,
        raise_host_refusal=True,
    )
    initialize.assert_awaited_once_with(
        original.id,
        relaunched,
        runner_client,
        store,
        initializer=initializer,
        suppress_recovery_turn=False,
        require_success=True,
    )
    relay_ready.assert_awaited_once_with(
        original.id,
        relaunched.runner_id,
        runner_client,
        store,
    )


@pytest.mark.asyncio
async def test_native_terminal_failure_stays_typed_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conv = _native_conv(runner_id="runner_live")
    monkeypatch.setattr(
        sessions_module,
        "_get_runner_client",
        AsyncMock(return_value=object()),
    )
    monkeypatch.setattr(
        sessions_module,
        "_ensure_native_terminal_ready",
        AsyncMock(
            return_value=_NativeTerminalEnsureOutcome(
                error=ErrorData(
                    source="execution",
                    code="native_terminal_ensure_failed",
                    message="Native terminal is unavailable.",
                )
            )
        ),
    )

    with pytest.raises(OmnigentError) as exc_info:
        await _reconcile_retry_session_readiness(
            session_id=conv.id,
            app_state=SimpleNamespace(),
            conversation_store=_Store(conv),
            runner_router=None,
        )

    assert exc_info.value.code == ErrorCode.RUNNER_UNAVAILABLE
    assert str(exc_info.value) == "Native terminal is unavailable."
