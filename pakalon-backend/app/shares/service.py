"""Share service: create/read/list/revoke shareable links."""
from __future__ import annotations

import secrets
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from sqlalchemy import String, Text, Float, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ShareScope(str, Enum):
    SESSION = "session"
    BRANCH = "branch"
    SNAPSHOT = "snapshot"
    PATCH = "patch"


class ShareRow(Base):
    __tablename__ = "shares"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    scope: Mapped[str] = mapped_column(String(32))
    target_id: Mapped[str] = mapped_column(String(64))
    author: Mapped[str] = mapped_column(String(64), default="")
    password_hash: Mapped[str] = mapped_column(String(128), default="")
    expires_at: Mapped[float] = mapped_column(Float, default=0.0)
    revoked: Mapped[bool] = mapped_column(Integer, default=0)
    view_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[float] = mapped_column(Float, default=time.time)


@dataclass(slots=True)
class Share:
    id: str
    token: str
    scope: ShareScope
    target_id: str
    author: str
    password_hash: str
    expires_at: float
    revoked: bool
    view_count: int
    created_at: float

    def url(self, base: str = "https://pakalon.com") -> str:
        return f"{base}/s/{self.token}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "token": self.token, "scope": self.scope.value,
            "target_id": self.target_id, "author": self.author,
            "expires_at": self.expires_at, "revoked": self.revoked,
            "view_count": self.view_count, "created_at": self.created_at,
            "url": self.url(),
        }


class ShareService:
    def __init__(self) -> None:
        pass

    def _new_id(self) -> str:
        return f"shr_{uuid.uuid4().hex[:16]}"

    def _new_token(self) -> str:
        return secrets.token_urlsafe(18)

    def _hash(self, password: str) -> str:
        if not password:
            return ""
        import hashlib
        return hashlib.sha256(password.encode("utf-8")).hexdigest()

    async def create(
        self,
        scope: ShareScope,
        target_id: str,
        *,
        author: str = "",
        password: str = "",
        ttl_seconds: int = 0,
    ) -> Share:
        from app.database import SessionLocal
        sid = self._new_id()
        token = self._new_token()
        now = time.time()
        row = ShareRow(
            id=sid, token=token, scope=scope.value, target_id=target_id,
            author=author, password_hash=self._hash(password),
            expires_at=(now + ttl_seconds) if ttl_seconds > 0 else 0.0,
            revoked=0, view_count=0, created_at=now,
        )
        async with SessionLocal() as s:
            s.add(row)
            await s.commit()
        return Share(
            id=sid, token=token, scope=scope, target_id=target_id,
            author=author, password_hash=row.password_hash,
            expires_at=row.expires_at, revoked=False,
            view_count=0, created_at=now,
        )

    async def get(self, token: str, *, password: str = "") -> Share | None:
        from app.database import SessionLocal
        from sqlalchemy import select
        async with SessionLocal() as s:
            stmt = select(ShareRow).where(ShareRow.token == token)
            row = (await s.execute(stmt)).scalars().first()
        if not row:
            return None
        if row.revoked:
            return None
        if row.expires_at and row.expires_at < time.time():
            return None
        if row.password_hash and self._hash(password) != row.password_hash:
            return None
        # bump view count
        async with SessionLocal() as s2:
            r = await s2.get(ShareRow, row.id)
            if r:
                r.view_count += 1
                await s2.commit()
                row = r
        return Share(
            id=row.id, token=row.token, scope=ShareScope(row.scope),
            target_id=row.target_id, author=row.author,
            password_hash=row.password_hash, expires_at=row.expires_at,
            revoked=bool(row.revoked), view_count=row.view_count,
            created_at=row.created_at,
        )

    async def revoke(self, token: str) -> bool:
        from app.database import SessionLocal
        from sqlalchemy import select
        async with SessionLocal() as s:
            row = (await s.execute(select(ShareRow).where(ShareRow.token == token))).scalars().first()
            if not row:
                return False
            row.revoked = 1
            await s.commit()
        return True

    async def list(self, author: str | None = None) -> list[Share]:
        from app.database import SessionLocal
        from sqlalchemy import select
        async with SessionLocal() as s:
            stmt = select(ShareRow).order_by(ShareRow.created_at.desc())
            if author:
                stmt = stmt.where(ShareRow.author == author)
            rows = (await s.execute(stmt)).scalars().all()
        return [
            Share(
                id=r.id, token=r.token, scope=ShareScope(r.scope),
                target_id=r.target_id, author=r.author,
                password_hash=r.password_hash, expires_at=r.expires_at,
                revoked=bool(r.revoked), view_count=r.view_count,
                created_at=r.created_at,
            )
            for r in rows
        ]
