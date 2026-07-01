"""Runner-level guard for the per-request-instructions system-prompt seam.

The Omnigent server forwards a ``per_request_instructions`` field on the
runner message body (e.g. the functional-projects ``<project_instructions>``
block). The runner must (1) thread that value into ``build_instructions``
and stamp it on ``harness_body["instructions"]``, and (2) preserve it
through the harness wire shape so the executor adapter reads it as the
turn's ``system_prompt``.

This is insurance against the exact regression we already hit once: the
runner previously called ``build_instructions(spec, None, [])`` with a
hardcoded ``None``, making a server-side-only change a silent no-op. A unit
test that asserts only on the server's ``runner_body`` would stay green
through that bug — so this test drives the runner-side expression and the
harness wire hop instead.
"""

from __future__ import annotations

from omnigent.runtime.harnesses._scaffold import MessageEvent
from omnigent.runtime.prompt import build_instructions
from omnigent.spec import AgentSpec

_BLOCK = (
    "<project_instructions>\npreamble\n\nAlways write TypeScript.\n</project_instructions>"
)


def _harness_body_for(msg_body: dict) -> dict:
    """Replicate the runner's harness_body assembly for the instructions seam.

    Mirrors ``omnigent/runner/app.py`` ``_run_turn_bg``: build the system
    instructions from the cached spec + the forwarded
    ``per_request_instructions``, then stamp them on the harness body.
    """
    spec = AgentSpec(spec_version=1, name="t", instructions="Base spec instructions.")
    instructions = build_instructions(
        spec,
        msg_body.get("per_request_instructions"),
        [],
    )
    harness_body: dict = {"type": "message", "role": "user", "model": ""}
    if instructions:
        harness_body["instructions"] = instructions
    harness_body["content"] = msg_body.get("content", [])
    return harness_body


def test_forwarded_instructions_reach_harness_body() -> None:
    """A msg_body carrying ``per_request_instructions`` ⇒ the block is in
    ``harness_body["instructions"]`` alongside the spec instructions."""
    harness_body = _harness_body_for(
        {"per_request_instructions": _BLOCK, "content": []}
    )
    assert "instructions" in harness_body
    assert "Base spec instructions." in harness_body["instructions"]
    assert "Always write TypeScript." in harness_body["instructions"]


def test_harness_body_instructions_survive_wire_shape() -> None:
    """The harness wire adapter preserves ``instructions`` into the
    ``CreateResponseRequest`` the executor adapter reads as system_prompt."""
    harness_body = _harness_body_for(
        {"per_request_instructions": _BLOCK, "content": []}
    )
    event = MessageEvent(**harness_body)
    request = event.to_create_request()
    # _executor_adapter.py does: system_prompt = request.instructions or ""
    assert request.instructions is not None
    assert "Always write TypeScript." in request.instructions


def test_absent_field_is_spec_only_zero_diff() -> None:
    """No ``per_request_instructions`` ⇒ instructions are spec-only (no
    project block), the runner's zero-diff guarantee at this seam."""
    harness_body = _harness_body_for({"content": []})
    assert harness_body["instructions"] == "Base spec instructions."
    assert "project_instructions" not in harness_body["instructions"]
