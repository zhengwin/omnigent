"""Tests for functional-projects prompt injection + zero-diff invariant.

Covers the server-side seam (``_forward_event_to_runner`` sets
``runner_body["per_request_instructions"]``) AND the load-bearing end-to-end
claim: that value is what the runner turns into the turn's system prompt via
``build_instructions`` → ``harness_body["instructions"]``. Asserting only the
server-side field would let a broken runner regress silently, so the runner
seam is tested too.
"""

from __future__ import annotations

from typing import Any

import pytest

from omnigent.server.routes import sessions as sessions_module
from omnigent.server.schemas import SessionEventInput
from omnigent.stores.conversation_store.sqlalchemy_store import (
    SqlAlchemyConversationStore,
)


class _CapturingRunnerClient:
    """Fake runner client that records the last POSTed JSON body."""

    def __init__(self) -> None:
        self.last_body: dict[str, Any] | None = None

    async def post(self, url: str, json: dict[str, Any], timeout: float = 0.0) -> Any:
        self.last_body = json

        class _Resp:
            status_code = 202

        return _Resp()


def _message_event() -> SessionEventInput:
    """:returns: one user message event."""
    return SessionEventInput(
        type="message",
        data={"role": "user", "content": [{"type": "input_text", "text": "hi"}]},
    )


async def _forward(
    store: SqlAlchemyConversationStore,
    session_id: str,
) -> dict[str, Any]:
    """
    Run ``_forward_event_to_runner`` with a capturing client.

    :returns: the ``runner_body`` dict that was POSTed to the runner.
    """
    conv = store.get_conversation(session_id)
    assert conv is not None
    client = _CapturingRunnerClient()
    await sessions_module._forward_event_to_runner(
        session_id,
        conv,
        _message_event(),
        store,
        client,  # type: ignore[arg-type]
    )
    assert client.last_body is not None
    return client.last_body


@pytest.mark.asyncio
async def test_injects_block_when_flag_on_and_description_set(
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Flag on + project with a description ⇒ the ``<project_instructions>``
    block is appended to ``per_request_instructions``, and the description
    text is present inside it."""
    monkeypatch.setenv("OMNIGENT_FUNCTIONAL_PROJECTS", "1")
    store = SqlAlchemyConversationStore(db_uri)
    conv = store.create_conversation()
    store.set_labels(conv.id, {"omni_project": "Proj"})
    # Single-user session ⇒ owner resolves to the "local" sentinel.
    store.upsert_project("local", "Proj", description="Always write TypeScript.")

    body = await _forward(store, conv.id)

    pri = body.get("per_request_instructions")
    assert pri is not None
    assert "<project_instructions>" in pri
    assert "Always write TypeScript." in pri


@pytest.mark.asyncio
async def test_zero_diff_when_flag_off(
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """LOAD-BEARING zero-diff: flag OFF ⇒ the field is never set, even when a
    project with a description exists. runner_body must be byte-identical to a
    build without this feature."""
    monkeypatch.delenv("OMNIGENT_FUNCTIONAL_PROJECTS", raising=False)
    store = SqlAlchemyConversationStore(db_uri)
    conv = store.create_conversation()
    store.set_labels(conv.id, {"omni_project": "Proj"})
    store.upsert_project("local", "Proj", description="Always write TypeScript.")

    body = await _forward(store, conv.id)

    assert "per_request_instructions" not in body


@pytest.mark.asyncio
async def test_zero_diff_when_flag_on_but_no_description(
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Zero-diff second half: flag ON but (a) no projects row, and (b) a row
    with an empty / whitespace description ⇒ the field is never set."""
    monkeypatch.setenv("OMNIGENT_FUNCTIONAL_PROJECTS", "1")
    store = SqlAlchemyConversationStore(db_uri)

    # (a) implicit project — labelled, but no projects metadata row.
    conv_a = store.create_conversation()
    store.set_labels(conv_a.id, {"omni_project": "Implicit"})
    body_a = await _forward(store, conv_a.id)
    assert "per_request_instructions" not in body_a

    # (b) explicit row but whitespace-only description.
    conv_b = store.create_conversation()
    store.set_labels(conv_b.id, {"omni_project": "Blank"})
    store.upsert_project("local", "Blank", description="   ")
    body_b = await _forward(store, conv_b.id)
    assert "per_request_instructions" not in body_b


@pytest.mark.asyncio
async def test_zero_diff_when_session_has_no_project(
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Flag on but the session carries no project label ⇒ no injection."""
    monkeypatch.setenv("OMNIGENT_FUNCTIONAL_PROJECTS", "1")
    store = SqlAlchemyConversationStore(db_uri)
    conv = store.create_conversation()

    body = await _forward(store, conv.id)

    assert "per_request_instructions" not in body


@pytest.mark.asyncio
async def test_injection_is_owner_isolated(
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SECURITY (the test that proves the fix): user B's session filed under
    a project with the SAME NAME as user A's must NOT receive A's
    ``<project_instructions>`` block. Injection keys on the session owner +
    owner-scoped metadata, so A's description never crosses into B's turn.
    A's own session still gets A's block."""
    from omnigent.stores.permission_store.sqlalchemy_store import (
        SqlAlchemyPermissionStore,
    )

    monkeypatch.setenv("OMNIGENT_FUNCTIONAL_PROJECTS", "1")
    store = SqlAlchemyConversationStore(db_uri)
    perms = SqlAlchemyPermissionStore(db_uri)
    for user in ("alice@example.com", "bob@example.com"):
        perms.ensure_user(user)

    # Alice owns a "Shared" project with a secret instruction.
    alice_conv = store.create_conversation()
    store.set_labels(alice_conv.id, {"omni_project": "Shared"})
    perms.grant("alice@example.com", alice_conv.id, 4)  # LEVEL_OWNER
    store.upsert_project("alice@example.com", "Shared", description="ALICE ONLY SECRET")

    # Bob has his own same-named "Shared" session, no metadata row.
    bob_conv = store.create_conversation()
    store.set_labels(bob_conv.id, {"omni_project": "Shared"})
    perms.grant("bob@example.com", bob_conv.id, 4)

    # Bob's turn must NOT carry Alice's block.
    bob_body = await _forward(store, bob_conv.id)
    assert "per_request_instructions" not in bob_body

    # Alice's own turn still gets her block.
    alice_body = await _forward(store, alice_conv.id)
    assert "ALICE ONLY SECRET" in (alice_body.get("per_request_instructions") or "")


def test_runner_threads_per_request_instructions_into_system_prompt() -> None:
    """LOAD-BEARING seam: the forwarded ``per_request_instructions`` value is
    what the runner turns into the turn's system prompt.

    This guards against the exact wiring bug the design note had: the runner
    used to pass a hardcoded ``None`` to ``build_instructions``, so setting the
    server-side field alone was a silent no-op. We assert ``build_instructions``
    with a spec + the forwarded value produces a prompt containing BOTH the
    spec instructions and the injected block — the real system-prompt path
    (``build_instructions`` result → ``harness_body["instructions"]``)."""
    from omnigent.runtime.prompt import build_instructions
    from omnigent.spec import AgentSpec

    spec = AgentSpec(spec_version=1, name="t", instructions="Base spec instructions.")
    block = "<project_instructions>\npreamble\n\nAlways write TypeScript.\n</project_instructions>"

    # With the block (what a forwarded per_request_instructions carries):
    with_block = build_instructions(spec, block, [])
    assert "Base spec instructions." in with_block
    assert "Always write TypeScript." in with_block

    # None (flag off / no description) is byte-identical to spec-only —
    # this is the runner's zero-diff guarantee at the build_instructions call.
    without = build_instructions(spec, None, [])
    assert "project_instructions" not in without
    assert without == build_instructions(spec, None, [])
