"""Tests for harness swarm backend endpoints.

Covers:
  - GET /harness/backends — list available swarm backends
  - POST /harness/backends/select — select active backend
  - GET /harness/teammates — list active teammates
  - POST /harness/teammates/spawn — spawn teammate
  - GET /harness/teammates/{id} — get teammate status
  - POST /harness/teammates/{id}/message — send message
  - DELETE /harness/teammates/{id} — kill teammate
"""
import pytest
from app.services.swarm_registry import SwarmBackendRegistry


# ──────────────────────────────────────────────────────────────────────────────
# Auth tests
# ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_backends_requires_auth(client):
    """GET /harness/backends without bearer token must return 401."""
    response = await client.get("/harness/backends")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_select_backend_requires_auth(client):
    """POST /harness/backends/select without bearer token must return 401."""
    response = await client.post(
        "/harness/backends/select",
        json={"backend": "in_process"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_teammates_requires_auth(client):
    """GET /harness/teammates without bearer token must return 401."""
    response = await client.get("/harness/teammates")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_spawn_teammate_requires_auth(client):
    """POST /harness/teammates/spawn without bearer token must return 401."""
    response = await client.post(
        "/harness/teammates/spawn",
        json={"role": "worker"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_get_teammate_requires_auth(client):
    """GET /harness/teammates/{id} without bearer token must return 401."""
    response = await client.get("/harness/teammates/some-id")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_send_message_requires_auth(client):
    """POST /harness/teammates/{id}/message without bearer token must return 401."""
    response = await client.post(
        "/harness/teammates/some-id/message",
        json={"message": "hello"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_kill_teammate_requires_auth(client):
    """DELETE /harness/teammates/{id} without bearer token must return 401."""
    response = await client.delete("/harness/teammates/some-id")
    assert response.status_code == 401


# ──────────────────────────────────────────────────────────────────────────────
# Backend listing
# ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_backends(client, free_user):
    """GET /harness/backends returns all 4 backend types."""
    from tests.conftest import make_jwt_for_user

    token = make_jwt_for_user(free_user)
    response = await client.get(
        "/harness/backends",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "backends" in data
    types = [b["type"] for b in data["backends"]]
    assert "in_process" in types
    assert "tmux" in types
    assert "iterm" in types
    assert "pane" in types
    # in_process should be active by default
    active = [b for b in data["backends"] if b["active"]]
    assert len(active) == 1
    assert active[0]["type"] == "in_process"


@pytest.mark.asyncio
async def test_select_valid_backend(client, free_user):
    """POST /harness/backends/select with a valid backend returns success."""
    from tests.conftest import make_jwt_for_user

    token = make_jwt_for_user(free_user)
    response = await client.post(
        "/harness/backends/select",
        json={"backend": "tmux"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["type"] == "tmux"
    assert data["active"] is True


@pytest.mark.asyncio
async def test_select_invalid_backend_returns_400(client, free_user):
    """POST /harness/backends/select with invalid backend returns 400."""
    from tests.conftest import make_jwt_for_user

    token = make_jwt_for_user(free_user)
    response = await client.post(
        "/harness/backends/select",
        json={"backend": "nonexistent"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 400


# ──────────────────────────────────────────────────────────────────────────────
# Teammate lifecycle
# ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_spawn_teammate(client, free_user):
    """POST /harness/teammates/spawn creates a teammate."""
    from tests.conftest import make_jwt_for_user

    token = make_jwt_for_user(free_user)
    response = await client.post(
        "/harness/teammates/spawn",
        json={"role": "worker"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 201
    data = response.json()
    teammate = data["teammate"]
    assert teammate["role"] == "worker"
    assert teammate["status"] == "starting"
    assert teammate["id"] is not None


@pytest.mark.asyncio
async def test_list_teammates(client, free_user):
    """GET /harness/teammates returns spawned teammates."""
    from tests.conftest import make_jwt_for_user

    token = make_jwt_for_user(free_user)
    # Spawn two teammates
    await client.post(
        "/harness/teammates/spawn",
        json={"role": "worker"},
        headers={"Authorization": f"Bearer {token}"},
    )
    await client.post(
        "/harness/teammates/spawn",
        json={"role": "auditor"},
        headers={"Authorization": f"Bearer {token}"},
    )
    response = await client.get(
        "/harness/teammates",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data["teammates"]) == 2
    roles = {t["role"] for t in data["teammates"]}
    assert "worker" in roles
    assert "auditor" in roles


@pytest.mark.asyncio
async def test_get_teammate_by_id(client, free_user):
    """GET /harness/teammates/{id} returns the specific teammate."""
    from tests.conftest import make_jwt_for_user

    token = make_jwt_for_user(free_user)
    spawn_resp = await client.post(
        "/harness/teammates/spawn",
        json={"role": "worker"},
        headers={"Authorization": f"Bearer {token}"},
    )
    teammate_id = spawn_resp.json()["teammate"]["id"]

    response = await client.get(
        f"/harness/teammates/{teammate_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == teammate_id
    assert data["role"] == "worker"


@pytest.mark.asyncio
async def test_get_teammate_not_found(client, free_user):
    """GET /harness/teammates/{id} returns 404 for unknown id."""
    from tests.conftest import make_jwt_for_user

    token = make_jwt_for_user(free_user)
    response = await client.get(
        "/harness/teammates/nonexistent-id",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_send_message_to_teammate(client, free_user):
    """POST /harness/teammates/{id}/message delivers the message."""
    from tests.conftest import make_jwt_for_user

    token = make_jwt_for_user(free_user)
    spawn_resp = await client.post(
        "/harness/teammates/spawn",
        json={"role": "worker"},
        headers={"Authorization": f"Bearer {token}"},
    )
    teammate_id = spawn_resp.json()["teammate"]["id"]

    response = await client.post(
        f"/harness/teammates/{teammate_id}/message",
        json={"message": "do something"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["delivered"] is True
    assert data["teammate_id"] == teammate_id
    assert data["message"] == "do something"


@pytest.mark.asyncio
async def test_send_message_to_unknown_teammate(client, free_user):
    """POST /harness/teammates/{id}/message returns 404 for unknown id."""
    from tests.conftest import make_jwt_for_user

    token = make_jwt_for_user(free_user)
    response = await client.post(
        "/harness/teammates/nonexistent-id/message",
        json={"message": "hello"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_kill_teammate(client, free_user):
    """DELETE /harness/teammates/{id} stops the teammate."""
    from tests.conftest import make_jwt_for_user

    token = make_jwt_for_user(free_user)
    spawn_resp = await client.post(
        "/harness/teammates/spawn",
        json={"role": "worker"},
        headers={"Authorization": f"Bearer {token}"},
    )
    teammate_id = spawn_resp.json()["teammate"]["id"]

    response = await client.delete(
        f"/harness/teammates/{teammate_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["teammate_id"] == teammate_id

    # Verify teammate shows as stopped
    get_resp = await client.get(
        f"/harness/teammates/{teammate_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert get_resp.status_code == 200
    assert get_resp.json()["status"] == "stopped"


@pytest.mark.asyncio
async def test_kill_unknown_teammate(client, free_user):
    """DELETE /harness/teammates/{id} returns 404 for unknown id."""
    from tests.conftest import make_jwt_for_user

    token = make_jwt_for_user(free_user)
    response = await client.delete(
        "/harness/teammates/nonexistent-id",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 404


# ──────────────────────────────────────────────────────────────────────────────
# Unit tests for SwarmBackendRegistry
# ──────────────────────────────────────────────────────────────────────────────


def test_registry_list_backends():
    """Registry lists all 4 backends for a new session."""
    reg = SwarmBackendRegistry()
    backends = reg.list_backends("test-session")
    assert len(backends) == 4
    types = {b["type"] for b in backends}
    assert types == {"in_process", "tmux", "iterm", "pane"}


def test_registry_select_backend():
    """Registry can select and track the active backend."""
    reg = SwarmBackendRegistry()
    result = reg.select_backend("test-session", reg.list_backends("test-session")[1]["type"])
    # The selected backend should now be active
    assert result["active"] is True


def test_registry_spawn_and_list_teammates():
    """Registry spawns and lists teammates."""
    reg = SwarmBackendRegistry()
    reg.spawn_teammate("s1", role="worker")
    reg.spawn_teammate("s1", role="auditor")
    teammates = reg.list_teammates("s1")
    assert len(teammates) == 2
    roles = {t["role"] for t in teammates}
    assert roles == {"worker", "auditor"}


def test_registry_kill_teammate():
    """Registry kills a teammate and marks it stopped."""
    reg = SwarmBackendRegistry()
    t = reg.spawn_teammate("s1", role="worker")
    assert reg.kill_teammate("s1", t["id"]) is True
    updated = reg.get_teammate("s1", t["id"])
    assert updated["status"] == "stopped"


def test_registry_kill_unknown_returns_false():
    """Killing a non-existent teammate returns False."""
    reg = SwarmBackendRegistry()
    assert reg.kill_teammate("s1", "nope") is False


def test_registry_get_teammate_unknown_returns_empty():
    """Getting a non-existent teammate returns empty dict."""
    reg = SwarmBackendRegistry()
    assert reg.get_teammate("s1", "nope") == {}


def test_registry_send_message():
    """Registry delivers a message to a teammate."""
    reg = SwarmBackendRegistry()
    t = reg.spawn_teammate("s1", role="worker")
    result = reg.send_message("s1", t["id"], "do stuff")
    assert result["delivered"] is True
    assert result["message"] == "do stuff"


def test_registry_sessions_are_isolated():
    """Different session IDs maintain separate state."""
    reg = SwarmBackendRegistry()
    reg.spawn_teammate("s1", role="worker")
    reg.spawn_teammate("s2", role="auditor")
    assert len(reg.list_teammates("s1")) == 1
    assert len(reg.list_teammates("s2")) == 1
    assert reg.list_teammates("s1")[0]["role"] == "worker"
    assert reg.list_teammates("s2")[0]["role"] == "auditor"
