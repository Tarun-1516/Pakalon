"""Mental models: synthesized high-level summaries over memories.

A mental model is a short label + description that summarizes a cluster
of related memories. Created on-demand via the LLM hook (in service.py).
"""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Sequence

from sqlalchemy import String, Text, Float
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


@dataclass(slots=True)
class MentalModel:
    id: str
    name: str
    description: str
    memory_ids: list[str] = field(default_factory=list)
    confidence: float = 0.5
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


class MentalModelRow(Base):
    __tablename__ = "hindsight_mental_models"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str] = mapped_column(Text, default="")
    memory_ids: Mapped[str] = mapped_column(Text, default="[]")
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    created_at: Mapped[float] = mapped_column(Float, default=time.time)
    updated_at: Mapped[float] = mapped_column(Float, default=time.time)


class MentalModelStore:
    """Persistence for mental models."""

    async def upsert(
        self,
        name: str,
        description: str,
        memory_ids: Sequence[str],
        confidence: float = 0.5,
    ) -> MentalModel:
        from app.database import SessionLocal
        async with SessionLocal() as s:
            # find existing by name
            from sqlalchemy import select
            stmt = select(MentalModelRow).where(MentalModelRow.name == name)
            existing = (await s.execute(stmt)).scalars().first()
            now = time.time()
            if existing:
                existing.description = description
                existing.memory_ids = json.dumps(list(memory_ids))
                existing.confidence = confidence
                existing.updated_at = now
                await s.commit()
                return MentalModel(
                    id=existing.id,
                    name=existing.name,
                    description=existing.description,
                    memory_ids=json.loads(existing.memory_ids),
                    confidence=existing.confidence,
                    created_at=existing.created_at,
                    updated_at=existing.updated_at,
                )
            row = MentalModelRow(
                id=f"mm_{uuid.uuid4().hex[:16]}",
                name=name,
                description=description,
                memory_ids=json.dumps(list(memory_ids)),
                confidence=confidence,
                created_at=now,
                updated_at=now,
            )
            s.add(row)
            await s.commit()
            return MentalModel(
                id=row.id, name=row.name, description=row.description,
                memory_ids=list(memory_ids), confidence=confidence,
                created_at=now, updated_at=now,
            )

    async def list_models(self) -> list[MentalModel]:
        from app.database import SessionLocal
        from sqlalchemy import select
        async with SessionLocal() as s:
            rows = (await s.execute(select(MentalModelRow))).scalars().all()
        return [
            MentalModel(
                id=r.id, name=r.name, description=r.description,
                memory_ids=json.loads(r.memory_ids),
                confidence=r.confidence,
                created_at=r.created_at, updated_at=r.updated_at,
            )
            for r in rows
        ]
