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
) -> None:
    """``?detail=true`` returns {name, description, icon, session_count}
    objects, unioning implicit + explicit projects."""
    conv_store = SqlAlchemyConversationStore(db_uri)
    a = conv_store.create_conversation()
    conv_store.set_labels(a.id, {"omni_project": "Alpha"})
    conv_store.upsert_project("Alpha", description="do alpha things", icon="star")
    conv_store.upsert_project("EmptyExplicit", description="no members yet")

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


# ── GET /v1/sessions/projects/{name} ────────────────────────────────


async def test_get_project_detail(
    client: httpx.AsyncClient,
    db_uri: str,
) -> None:
    """Detail GET returns the {name, description, icon, session_count}
    contract the frontend built to."""
    conv_store = SqlAlchemyConversationStore(db_uri)
    a = conv_store.create_conversation()
    conv_store.set_labels(a.id, {"omni_project": "Alpha"})
    conv_store.upsert_project("Alpha", description="instructions", icon="rocket")

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
) -> None:
    """An implicit (label-only) project resolves with null description/icon."""
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
) -> None:
    """An unknown project (no members, no row) is a 404."""
    resp = await client.get("/v1/sessions/projects/Nope")
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
    # Persisted.
    rec = conv_store.get_project("Alpha")
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
    assert conv_store.get_project("Alpha") is None


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
