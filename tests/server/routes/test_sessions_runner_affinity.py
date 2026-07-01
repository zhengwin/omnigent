"""Runner-affinity create tests for top-level session placement."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from omnigent.errors import OmnigentError
from omnigent.runner.identity import OMNIGENT_INTERNAL_WS_ORIGIN
from omnigent.server.auth import LEVEL_OWNER, UnifiedAuthProvider
from omnigent.server.routes.sessions import create_sessions_router
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.stores.conversation_store.sqlalchemy_store import (
    SqlAlchemyConversationStore,
)
from omnigent.stores.permission_store.sqlalchemy_store import (
    SqlAlchemyPermissionStore,
)
from tests.server.helpers import build_agent_bundle

ALICE = "alice@example.com"
BOB = "bob@example.com"
SERVICE_PRINCIPAL = "sp-runner@example.com"
AGENT_ID = "ag_affinity"
RUNNER_ALICE = "runner_alice"
RUNNER_BOB = "runner_bob"
RUNNER_PARENT = "runner_parent"
RUNNER_SERVICE = "runner_service"
RUNNER_LOCAL = "runner_local"
RUNNER_BAD = "runner_bad"


class _FakeRunnerClient:
    """Minimal async runner client that records create notifications."""

    def __init__(self) -> None:
        self.posts: list[tuple[str, dict[str, Any] | None]] = []

    async def post(
        self,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> httpx.Response:
        del timeout
        self.posts.append((path, json))
        return httpx.Response(200)


class _FakeRunnerRouter:
    """Runner router stub with real online and owner semantics."""

    def __init__(
        self,
        conversation_store: SqlAlchemyConversationStore,
        *,
        owners: dict[str, str | None],
        online: set[str],
    ) -> None:
        self._conversation_store = conversation_store
        self._owners = owners
        self._online = online
        self.client = _FakeRunnerClient()

    def runner_is_online(self, runner_id: str) -> bool:
        return runner_id in self._online

    def runner_owner(self, runner_id: str) -> str | None:
        return self._owners.get(runner_id)

    def client_for_session_resources(self, conversation_id: str) -> SimpleNamespace:
        conv = self._conversation_store.get_conversation(conversation_id)
        if conv is None or conv.runner_id not in self._online:
            raise LookupError(conversation_id)
        return SimpleNamespace(runner_id=conv.runner_id, client=self.client)


@pytest.fixture
def stores(
    db_uri: str,
) -> tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore]:
    """Real file-backed stores backing the affinity route tests."""
    return (
        SqlAlchemyConversationStore(db_uri),
        SqlAlchemyAgentStore(db_uri),
        SqlAlchemyPermissionStore(db_uri),
    )


def _install_error_handler(app: FastAPI) -> None:
    """Mirror the production OmnigentError response shape."""

    @app.exception_handler(OmnigentError)
    async def _handle_omnigent_error(request: Request, exc: OmnigentError) -> JSONResponse:
        del request
        return JSONResponse(
            status_code=exc.http_status,
            content={"error": {"code": exc.code, "message": exc.message}},
        )


def _seed_agent(
    stores: tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore],
) -> None:
    _, agent_store, _ = stores
    if agent_store.get(AGENT_ID) is None:
        agent_store.create(
            agent_id=AGENT_ID,
            name="affinity-agent",
            bundle_location="ag_affinity/bundle",
        )


def _seed_parent(
    stores: tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore],
    *,
    runner_id: str,
) -> str:
    conversation_store, _, permission_store = stores
    _seed_agent(stores)
    conv = conversation_store.create_conversation(
        agent_id=AGENT_ID,
        title="parent",
        runner_id=runner_id,
    )
    permission_store.ensure_user(ALICE)
    permission_store.grant(ALICE, conv.id, LEVEL_OWNER)
    return conv.id


def _build_app(
    stores: tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore],
    *,
    runner_router: _FakeRunnerRouter,
    artifact_store: LocalArtifactStore,
) -> FastAPI:
    conversation_store, agent_store, permission_store = stores
    app = FastAPI()
    _install_error_handler(app)
    app.include_router(
        create_sessions_router(
            conversation_store=conversation_store,
            agent_store=agent_store,
            artifact_store=artifact_store,
            auth_provider=UnifiedAuthProvider(source="header"),
            permission_store=permission_store,
            runner_router=runner_router,  # type: ignore[arg-type]
        ),
        prefix="/v1",
    )
    return app


def _post_create(
    client: TestClient,
    shape: str,
    metadata: dict[str, Any],
) -> httpx.Response:
    headers = {
        "X-Forwarded-Email": ALICE,
        "Origin": OMNIGENT_INTERNAL_WS_ORIGIN,
    }
    if shape == "json":
        return client.post(
            "/v1/sessions",
            json={"agent_id": AGENT_ID, **metadata},
            headers=headers,
        )
    if shape == "multipart":
        return client.post(
            "/v1/sessions",
            data={"metadata": json.dumps(metadata)},
            files={"bundle": ("agent.tar.gz", build_agent_bundle(name="affinity-agent"))},
            headers=headers,
        )
    raise AssertionError(f"unknown shape: {shape}")


@pytest.mark.parametrize("shape", ["json", "multipart"])
def test_parentless_runner_affinity_binds_runner_and_grants_owner(
    stores: tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    shape: str,
) -> None:
    """Caller-owned online affinity binds the session and preserves owner grant."""
    monkeypatch.setenv("OMNIGENT_LOCAL_SINGLE_USER", "1")
    conversation_store, _, permission_store = stores
    _seed_agent(stores)
    runner_router = _FakeRunnerRouter(
        conversation_store,
        owners={RUNNER_ALICE: ALICE},
        online={RUNNER_ALICE},
    )
    app = _build_app(
        stores,
        runner_router=runner_router,
        artifact_store=LocalArtifactStore(str(tmp_path / "artifacts")),
    )

    resp = _post_create(TestClient(app), shape, {"runner_affinity_id": RUNNER_ALICE})

    assert resp.status_code == 201
    session_id = resp.json()["id"] if shape == "json" else resp.json()["session_id"]
    conv = conversation_store.get_conversation(session_id)
    assert conv is not None
    assert conv.runner_id == RUNNER_ALICE
    grant = permission_store.get(ALICE, session_id)
    assert grant is not None
    assert grant.level == LEVEL_OWNER
    assert runner_router.client.posts[0][0] == "/v1/sessions"


@pytest.mark.parametrize("shape", ["json", "multipart"])
def test_local_single_user_affinity_grants_create_caller_when_runner_has_no_owner(
    stores: tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    shape: str,
) -> None:
    """Placement writes runner_id, while ownership still grants the create caller."""
    monkeypatch.setenv("OMNIGENT_LOCAL_SINGLE_USER", "1")
    conversation_store, _, permission_store = stores
    _seed_agent(stores)
    runner_router = _FakeRunnerRouter(
        conversation_store,
        owners={RUNNER_LOCAL: None},
        online={RUNNER_LOCAL},
    )
    app = _build_app(
        stores,
        runner_router=runner_router,
        artifact_store=LocalArtifactStore(str(tmp_path / "artifacts")),
    )

    resp = _post_create(TestClient(app), shape, {"runner_affinity_id": RUNNER_LOCAL})

    assert resp.status_code == 201
    session_id = resp.json()["id"] if shape == "json" else resp.json()["session_id"]
    conv = conversation_store.get_conversation(session_id)
    assert conv is not None
    assert conv.runner_id == RUNNER_LOCAL
    assert permission_store.get(ALICE, session_id) is not None


@pytest.mark.parametrize("shape", ["json", "multipart"])
def test_parentless_runner_affinity_rejects_other_owned_runner(
    stores: tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    shape: str,
) -> None:
    """A different user's online runner is rejected instead of silently cleared."""
    monkeypatch.setenv("OMNIGENT_LOCAL_SINGLE_USER", "1")
    conversation_store, _, _ = stores
    _seed_agent(stores)
    runner_router = _FakeRunnerRouter(
        conversation_store,
        owners={RUNNER_BOB: BOB},
        online={RUNNER_BOB},
    )
    app = _build_app(
        stores,
        runner_router=runner_router,
        artifact_store=LocalArtifactStore(str(tmp_path / "artifacts")),
    )

    resp = _post_create(TestClient(app), shape, {"runner_affinity_id": RUNNER_BOB})

    assert resp.status_code == 403
    assert "not owned by the requesting user" in resp.json()["error"]["message"]
    assert conversation_store.list_conversations_by_runner_id(RUNNER_BOB) == []


@pytest.mark.parametrize("shape", ["json", "multipart"])
@pytest.mark.parametrize("runner_id", ["runner_unknown", "runner_offline"])
def test_parentless_runner_affinity_rejects_unknown_or_offline_runner(
    stores: tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    shape: str,
    runner_id: str,
) -> None:
    """Unknown or offline affinity fails before any conversation row is created."""
    monkeypatch.setenv("OMNIGENT_LOCAL_SINGLE_USER", "1")
    conversation_store, _, _ = stores
    _seed_agent(stores)
    runner_router = _FakeRunnerRouter(
        conversation_store,
        owners={runner_id: ALICE},
        online=set(),
    )
    app = _build_app(
        stores,
        runner_router=runner_router,
        artifact_store=LocalArtifactStore(str(tmp_path / "artifacts")),
    )

    resp = _post_create(TestClient(app), shape, {"runner_affinity_id": runner_id})

    assert resp.status_code == 400
    assert "is not registered" in resp.json()["error"]["message"]
    assert conversation_store.list_conversations_by_runner_id(runner_id) == []


@pytest.mark.parametrize("shape", ["json", "multipart"])
def test_parentless_runner_affinity_rejects_managed_without_verified_owner(
    stores: tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    shape: str,
) -> None:
    """Multi-user parentless affinity rejects non-caller runners with the v2 guardrail."""
    monkeypatch.delenv("OMNIGENT_LOCAL_SINGLE_USER", raising=False)
    conversation_store, _, _ = stores
    _seed_agent(stores)
    runner_router = _FakeRunnerRouter(
        conversation_store,
        owners={RUNNER_SERVICE: SERVICE_PRINCIPAL},
        online={RUNNER_SERVICE},
    )
    app = _build_app(
        stores,
        runner_router=runner_router,
        artifact_store=LocalArtifactStore(str(tmp_path / "artifacts")),
    )

    resp = _post_create(TestClient(app), shape, {"runner_affinity_id": RUNNER_SERVICE})

    assert resp.status_code == 400
    assert "managed/hosted spawn is not yet supported" in resp.json()["error"]["message"]
    assert conversation_store.list_conversations_by_runner_id(RUNNER_SERVICE) == []


@pytest.mark.parametrize("shape", ["json", "multipart"])
def test_parent_session_inheritance_ignores_runner_affinity(
    stores: tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    shape: str,
) -> None:
    """Parent inheritance wins and the affinity field is ignored when both are set."""
    monkeypatch.delenv("OMNIGENT_LOCAL_SINGLE_USER", raising=False)
    conversation_store, _, _ = stores
    parent_id = _seed_parent(stores, runner_id=RUNNER_PARENT)
    runner_router = _FakeRunnerRouter(
        conversation_store,
        owners={RUNNER_PARENT: ALICE},
        online={RUNNER_PARENT},
    )
    app = _build_app(
        stores,
        runner_router=runner_router,
        artifact_store=LocalArtifactStore(str(tmp_path / "artifacts")),
    )

    resp = _post_create(
        TestClient(app),
        shape,
        {
            "parent_session_id": parent_id,
            "runner_affinity_id": RUNNER_BAD,
        },
    )

    assert resp.status_code == 201
    session_id = resp.json()["id"] if shape == "json" else resp.json()["session_id"]
    conv = conversation_store.get_conversation(session_id)
    assert conv is not None
    assert conv.parent_conversation_id == parent_id
    assert conv.runner_id == RUNNER_PARENT
    assert conversation_store.list_conversations_by_runner_id(RUNNER_BAD) == []


@pytest.mark.parametrize("shape", ["json", "multipart"])
def test_parentless_create_without_runner_affinity_remains_unbound(
    stores: tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    shape: str,
) -> None:
    """Omitting affinity preserves the existing unbound top-level create behavior."""
    monkeypatch.delenv("OMNIGENT_LOCAL_SINGLE_USER", raising=False)
    conversation_store, _, _ = stores
    _seed_agent(stores)
    runner_router = _FakeRunnerRouter(conversation_store, owners={}, online=set())
    app = _build_app(
        stores,
        runner_router=runner_router,
        artifact_store=LocalArtifactStore(str(tmp_path / "artifacts")),
    )

    resp = _post_create(TestClient(app), shape, {})

    assert resp.status_code == 201
    session_id = resp.json()["id"] if shape == "json" else resp.json()["session_id"]
    conv = conversation_store.get_conversation(session_id)
    assert conv is not None
    assert conv.parent_conversation_id is None
    assert conv.runner_id is None
    assert runner_router.client.posts == []
