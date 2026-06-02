"""Weekly digest job — daily runner that sends a 7-day rolling summary to each active user."""
import hashlib
import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.jobs.billing_notifications import buildWeeklyDigest, sendWeeklyDigestEmail
from app.models.email_queue import EmailQueue
from app.models.user import User
from app.schemas.notifications import DigestSummary

logger = logging.getLogger(__name__)


def _idempotency_key(user_id: str, date_str: str) -> str:
    """Generate a deterministic idempotency key for a user+date pair."""
    raw = f"weekly_digest:{user_id}:{date_str}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


async def _already_sent_today(
    session: AsyncSession,
    user_id: str,
    date_str: str,
) -> bool:
    """Check if a weekly digest was already queued or sent today for this user."""
    from sqlalchemy import func  # noqa: PLC0415

    result = await session.execute(
        select(func.count()).select_from(EmailQueue).where(
            EmailQueue.user_id == user_id,
            EmailQueue.email_type == "weekly_digest",
            EmailQueue.status.in_(["pending", "sending", "sent"]),
            func.date(EmailQueue.created_at) == date_str,
        )
    )
    return (result.scalar_one() or 0) > 0


async def run_weekly_digest_for_user(
    user_id: str,
    session: AsyncSession,
) -> str | None:
    """
    Run the weekly digest for a single user.

    Returns the email_queue ID if queued, None if skipped (already sent
    today or user not found).
    """
    now = datetime.now(tz=UTC)
    date_str = now.strftime("%Y-%m-%d")

    if await _already_sent_today(session, user_id, date_str):
        logger.debug("Weekly digest already sent today for user %s, skipping", user_id)
        return None

    summary: DigestSummary = await buildWeeklyDigest(
        user_id=user_id,
        window_days=7,
        session=session,
    )

    if not summary.notifications_by_day and summary.alert_count == 0:
        logger.debug("Weekly digest empty for user %s, skipping", user_id)
        return None

    email_id = await sendWeeklyDigestEmail(
        user_id=user_id,
        summary=summary,
        session=session,
    )

    if email_id:
        logger.info("Weekly digest queued user_id=%s email_id=%s", user_id, email_id)

    return email_id


async def run_weekly_digest_batch() -> None:
    """
    Scheduled job (cron daily 09:00 UTC).

    Iterates over all active, non-deleted users with an email address
    and sends each a 7-day rolling digest summary.
    """
    from sqlalchemy.ext.asyncio import async_sessionmaker  # noqa: PLC0415

    from app.database import make_async_engine  # noqa: PLC0415

    engine = make_async_engine(echo=False)
    async_session = async_sessionmaker(engine, expire_on_commit=False)

    stats = {"users_processed": 0, "digests_queued": 0, "errors": 0}

    try:
        async with async_session() as session:
            result = await session.execute(
                select(User).where(
                    User.account_deleted == False,  # noqa: E712
                    User.email.isnot(None),
                )
            )
            users = result.scalars().all()

            for user in users:
                try:
                    email_id = await run_weekly_digest_for_user(
                        user_id=user.id,
                        session=session,
                    )
                    stats["users_processed"] += 1
                    if email_id:
                        stats["digests_queued"] += 1
                except Exception as exc:
                    logger.error(
                        "Failed to send weekly digest for user %s: %s",
                        user.id,
                        exc,
                    )
                    stats["errors"] += 1

            await session.commit()

        logger.info("Weekly digest batch complete: %s", stats)
    except Exception as exc:
        logger.exception("Weekly digest batch job failed: %s", exc)
    finally:
        await engine.dispose()
