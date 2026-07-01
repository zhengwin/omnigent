"""Tests for the functional-projects HTTP routes + /v1/info flag bridge.

Covers the detailed list (``?detail=true``), the project detail GET, the
description-upsert PUT (incl. flag gating), and the ``functional_projects_enabled``
field on ``/v1/info``. Uses the shared ``client`` fixture (single-user, unauthed).
"""

from __future__ import annotations

import httpx
import pytest

from omnigent.stores.conversation_store.sqlalchemy_store import (
    SqlAlchemyConversationStore,
)

# ── GET /v1/info flag bridge ────────────────────────────────────────


async def test_info_flag_off_by_default(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``functional_projects_enabled`` is present and False when the env
    var is unset — the zero-diff default the SPA gates on."""
    monkeypatch.delenv("OMNIGENT_FUNCTIONAL_PROJECTS", raising=False)
    resp = await client.get("/v1/info")
    assert resp.status_code == 200
    assert resp.json()["functional_projects_enabled"] is False


async def test_info_flag_on_when_env_set(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The field flips to True when ``OMNIGENT_FUNCTIONAL_PROJECTS=1``."""
    monkeypatch.setenv("OMNIGENT_FUNCTIONAL_PROJECTS", "1")
    resp = await client.get("/v1/info")
    assert resp.status_code == 200
    assert resp.json()["functional_projects_enabled"] is True


# ── GET /v1/sessions/projects?detail=true ───────────────────────────


async def test_list_projects_plain_shape_unchanged(
    client: httpx.AsyncClient,
    db_uri: str,
) -> None:
    """Without ``detail`` the list endpoint still returns the legacy
    ``list[str]`` — backward-compatible for the existing sidebar."""
    conv_store = SqlAlchemyConversationStore(db_uri)
    a = conv_store.create_conversation()
    conv_store.set_labels(a.id, {"omni_project": "Alpha"})

    resp = await client.get("/v1/sessions/projects")
    assert resp.status_code == 200
    assert resp.json() == ["Alpha"]


async def test_list_projects_detailed_shape(
    client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``?detail=true`` (flag on) returns {name, description, icon,
    session_count} objects, unioning implicit + explicit projects. Explicit
    rows use the single-user ``"local"`` owner."""
    monkeypatch.setenv("OMNIGENT_FUNCTIONAL_PROJECTS", "1")
    conv_store = SqlAlchemyConversationStore(db_uri)
    a = conv_store.create_conversation()
    conv_store.set_labels(a.id, {"omni_project": "Alpha"})
    conv_store.upsert_project("local", "Alpha", description="do alpha things", icon="star")
    conv_store.upsert_project("local", "EmptyExplicit", description="no members yet")

    resp = await client.get("/v1/sessions/projects?detail=true")
    assert resp.status_code == 200
    by_name = {r["name"]: r for r in resp.json()}
    assert set(by_name) == {"Alpha", "EmptyExplicit"}
    assert by_name["Alpha"] == {
        "name": "Alpha",
        "description": "do alpha things",
        "icon": "star",
        "session_count": 1,
    }
    assert by_name["EmptyExplicit"]["session_count"] == 0


async def test_list_projects_detailed_404_when_flag_off(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``?detail=true`` is flag-gated: 404 when off (the plain names path
    stays available), so the enriched surface is zero when the feature is
    disabled."""
    monkeypatch.delenv("OMNIGENT_FUNCTIONAL_PROJECTS", raising=False)
    resp = await client.get("/v1/sessions/projects?detail=true")
    assert resp.status_code == 404
    # Plain list still works with the flag off.
    assert (await client.get("/v1/sessions/projects")).status_code == 200


# ── GET /v1/sessions/projects/{name} ────────────────────────────────


async def test_get_project_detail(
    client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Detail GET returns the {name, description, icon, session_count}
    contract the frontend built to."""
    monkeypatch.setenv("OMNIGENT_FUNCTIONAL_PROJECTS", "1")
    conv_store = SqlAlchemyConversationStore(db_uri)
    a = conv_store.create_conversation()
    conv_store.set_labels(a.id, {"omni_project": "Alpha"})
    conv_store.upsert_project("local", "Alpha", description="instructions", icon="rocket")

    resp = await client.get("/v1/sessions/projects/Alpha")
    assert resp.status_code == 200
    assert resp.json() == {
        "name": "Alpha",
        "description": "instructions",
        "icon": "rocket",
        "session_count": 1,
    }


async def test_get_project_detail_implicit_null_metadata(
    client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An implicit (label-only) project resolves with null description/icon."""
    monkeypatch.setenv("OMNIGENT_FUNCTIONAL_PROJECTS", "1")
    conv_store = SqlAlchemyConversationStore(db_uri)
    a = conv_store.create_conversation()
    conv_store.set_labels(a.id, {"omni_project": "Implicit"})

    resp = await client.get("/v1/sessions/projects/Implicit")
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Implicit"
    assert body["description"] is None
    assert body["icon"] is None
    assert body["session_count"] == 1


async def test_get_project_detail_404_when_unknown(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unknown project (no members, no row) is a 404."""
    monkeypatch.setenv("OMNIGENT_FUNCTIONAL_PROJECTS", "1")
    resp = await client.get("/v1/sessions/projects/Nope")
    assert resp.status_code == 404


async def test_get_project_detail_404_when_flag_off(
    client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Detail GET is flag-gated too: 404 when off even for a real project."""
    monkeypatch.delenv("OMNIGENT_FUNCTIONAL_PROJECTS", raising=False)
    conv_store = SqlAlchemyConversationStore(db_uri)
    a = conv_store.create_conversation()
    conv_store.set_labels(a.id, {"omni_project": "Alpha"})

    resp = await client.get("/v1/sessions/projects/Alpha")
    assert resp.status_code == 404


# ── PUT /v1/sessions/projects/{name} ────────────────────────────────


async def test_put_project_upserts_description(
    client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Flag on: PUT upserts the description and echoes the detail shape."""
    monkeypatch.setenv("OMNIGENT_FUNCTIONAL_PROJECTS", "1")
    conv_store = SqlAlchemyConversationStore(db_uri)
    a = conv_store.create_conversation()
    conv_store.set_labels(a.id, {"omni_project": "Alpha"})

    resp = await client.put(
        "/v1/sessions/projects/Alpha",
        json={"description": "be excellent", "icon": "star"},
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "name": "Alpha",
        "description": "be excellent",
        "icon": "star",
        "session_count": 1,
    }
    # Persisted under the single-user "local" owner.
    rec = conv_store.get_project("local", "Alpha")
    assert rec is not None
    assert rec.description == "be excellent"


async def test_put_project_404_when_flag_off(
    client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Flag off: PUT behaves as though the route does not exist (404) and
    writes nothing — the write path is gated, preserving zero-diff."""
    monkeypatch.delenv("OMNIGENT_FUNCTIONAL_PROJECTS", raising=False)
    conv_store = SqlAlchemyConversationStore(db_uri)
    a = conv_store.create_conversation()
    conv_store.set_labels(a.id, {"omni_project": "Alpha"})

    resp = await client.put(
        "/v1/sessions/projects/Alpha",
        json={"description": "should not persist"},
    )
    assert resp.status_code == 404
    assert conv_store.get_project("local", "Alpha") is None


async def test_put_project_404_when_not_visible(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Flag on but the project is neither an accessible member project nor an
    existing row ⇒ 404 (can't create metadata for an invisible project)."""
    monkeypatch.setenv("OMNIGENT_FUNCTIONAL_PROJECTS", "1")
    resp = await client.put(
        "/v1/sessions/projects/Ghost",
        json={"description": "x"},
    )
    assert resp.status_code == 404


async def test_put_project_rejects_overlong_description(
    client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A description over the 8000-char cap is rejected with 422 (Pydantic
    validation) — bounds per-turn prompt bloat."""
    monkeypatch.setenv("OMNIGENT_FUNCTIONAL_PROJECTS", "1")
    conv_store = SqlAlchemyConversationStore(db_uri)
    a = conv_store.create_conversation()
    conv_store.set_labels(a.id, {"omni_project": "Alpha"})

    resp = await client.put(
        "/v1/sessions/projects/Alpha",
        json={"description": "x" * 8001},
    )
    assert resp.status_code == 422
    # Nothing persisted.
    assert conv_store.get_project("local", "Alpha") is None
