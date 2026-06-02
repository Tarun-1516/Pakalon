"""In-memory swarm backend registry — tracks available backends and active teammates per session."""

import logging
import uuid
from datetime import datetime, timezone
from enum import Enum

logger = logging.getLogger(__name__)


class SwarmBackendType(str, Enum):
    """Available swarm backend types."""

    IN_PROCESS = "in_process"
    TMUX = "tmux"
    ITERM = "iterm"
    PANE = "pane"


class TeammateStatus(str, Enum):
    """Lifecycle status of a spawned teammate."""

    STARTING = "starting"
    RUNNING = "running"
    IDLE = "idle"
    BUSY = "busy"
    STOPPED = "stopped"
    ERROR = "error"


class TeammateRecord:
    """Internal record for a spawned teammate."""

    __slots__ = (
        "id",
        "backend",
        "status",
        "role",
        "pid",
        "session_id",
        "created_at",
        "last_activity_at",
    )

    id: str
    backend: SwarmBackendType
    status: TeammateStatus
    role: str
    pid: int | None
    session_id: str | None
    created_at: datetime
    last_activity_at: datetime

    def __init__(
        self,
        backend: SwarmBackendType,
        role: str,
        pid: int | None = None,
        session_id: str | None = None,
    ) -> None:
        self.id = str(uuid.uuid4())
        self.backend = backend
        self.status = TeammateStatus.STARTING
        self.role = role
        self.pid = pid
        self.session_id = session_id
        now = datetime.now(tz=timezone.utc)
        self.created_at = now
        self.last_activity_at = now

    def to_dict(self) -> dict[str, str | int | None]:
        return {
            "id": self.id,
            "backend": self.backend.value,
            "status": self.status.value,
            "role": self.role,
            "pid": self.pid,
            "session_id": self.session_id,
            "created_at": self.created_at.isoformat(),
            "last_activity_at": self.last_activity_at.isoformat(),
        }


class _SessionState:
    """Per-session registry state."""

    __slots__ = ("active_backend", "available_backends", "teammates")

    def __init__(self) -> None:
        self.active_backend: SwarmBackendType = SwarmBackendType.IN_PROCESS
        self.available_backends: set[SwarmBackendType] = set(SwarmBackendType)
        self.teammates: dict[str, TeammateRecord] = {}


class SwarmBackendRegistry:
    """Singleton registry that tracks backends and teammates per session.

    The registry is purely in-memory — the CLI is the source of truth for
    actual teammate processes.  The backend mirrors state so the API can
    answer queries without round-tripping to every CLI instance.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, _SessionState] = {}

    def _get_session(self, session_id: str) -> _SessionState:
        if session_id not in self._sessions:
            self._sessions[session_id] = _SessionState()
        return self._sessions[session_id]

    # ── Backend management ────────────────────────────────────────────────

    def list_backends(self, session_id: str) -> list[dict[str, str | bool]]:
        state = self._get_session(session_id)
        return [
            {
                "type": b.value,
                "available": b in state.available_backends,
                "active": b == state.active_backend,
            }
            for b in SwarmBackendType
        ]

    def select_backend(self, session_id: str, backend: SwarmBackendType) -> dict[str, str | bool]:
        state = self._get_session(session_id)
        if backend not in state.available_backends:
            msg = f"Backend '{backend.value}' is not available for this session"
            raise ValueError(msg)
        state.active_backend = backend
        logger.info("Session %s: active backend → %s", session_id, backend.value)
        return {
            "type": backend.value,
            "available": True,
            "active": True,
        }

    def register_backend(self, session_id: str, backend: SwarmBackendType) -> None:
        """Mark a backend as available for a session (called by CLI on connect)."""
        state = self._get_session(session_id)
        state.available_backends.add(backend)

    # ── Teammate management ───────────────────────────────────────────────

    def list_teammates(self, session_id: str) -> list[dict[str, str | int | None]]:
        state = self._get_session(session_id)
        return [t.to_dict() for t in state.teammates.values()]

    def get_teammate(self, session_id: str, teammate_id: str) -> dict[str, str | int | None]:
        state = self._get_session(session_id)
        teammate = state.teammates.get(teammate_id)
        if teammate is None:
            return {}
        return teammate.to_dict()

    def spawn_teammate(
        self,
        session_id: str,
        role: str,
        pid: int | None = None,
    ) -> dict[str, str | int | None]:
        state = self._get_session(recorded_session := session_id)
        record = TeammateRecord(
            backend=state.active_backend,
            role=role,
            pid=pid,
            session_id=recorded_session,
        )
        state.teammates[record.id] = record
        logger.info("Spawned teammate %s (role=%s, backend=%s)", record.id, role, state.active_backend.value)
        return record.to_dict()

    def update_teammate_status(
        self,
        session_id: str,
        teammate_id: str,
        new_status: TeammateStatus,
    ) -> dict[str, str | int | None]:
        state = self._get_session(session_id)
        teammate = state.teammates.get(teammate_id)
        if teammate is None:
            return {}
        teammate.status = new_status
        teammate.last_activity_at = datetime.now(tz=timezone.utc)
        return teammate.to_dict()

    def kill_teammate(self, session_id: str, teammate_id: str) -> bool:
        state = self._get_session(session_id)
        teammate = state.teammates.get(teammate_id)
        if teammate is None:
            return False
        teammate.status = TeammateStatus.STOPPED
        teammate.last_activity_at = datetime.now(tz=timezone.utc)
        logger.info("Killed teammate %s", teammate_id)
        return True

    def send_message(
        self,
        session_id: str,
        teammate_id: str,
        message: str,
    ) -> dict[str, str | bool | None]:
        state = self._get_session(session_id)
        teammate = state.teammates.get(teammate_id)
        if teammate is None:
            return {"delivered": False, "error": "teammate not found"}
        teammate.last_activity_at = datetime.now(tz=timezone.utc)
        return {
            "delivered": True,
            "teammate_id": teammate_id,
            "message": message,
        }


# Module-level singleton — one registry for the lifetime of the process.
swarm_registry = SwarmBackendRegistry()
