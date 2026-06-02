"""Tests for weekly digest job."""
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.jobs.billing_notifications import buildWeeklyDigest, sendWeeklyDigestEmail
from app.jobs.email_queue import enqueueWeeklyDigest
from app.jobs.weekly_digest import (
    _already_sent_today,
    _idempotency_key,
    run_weekly_digest_for_user,
)
from app.models.email_queue import EmailQueue
from app.models.notification import Notification
from app.schemas.notifications import (
    CategoryCount,
    DigestSummary,
    NotificationDigestItem,
)

# ── DigestSummary schema tests ────────────────────────────────────


def test_digest_summary_fields():
    """DigestSummary should have all required fields."""
    now = datetime.now(tz=UTC)
    summary = DigestSummary(
        user_id="test-user-id",
        window_days=7,
        total_spend=42.50,
        top_categories=[
            CategoryCount(category="billing_reminder", count=3),
            CategoryCount(category="trial_expiring_soon", count=1),
        ],
        alert_count=4,
        notifications_by_day={
            "2026-05-30": [
                NotificationDigestItem(
                    id="n1",
                    notification_type="billing_reminder",
                    title="Test",
                    body="Body",
                    read=False,
                    created_at=now,
                )
            ]
        },
        generated_at=now,
    )
    assert summary.user_id == "test-user-id"
    assert summary.window_days == 7
    assert summary.total_spend == 42.50
    assert len(summary.top_categories) == 2
    assert summary.alert_count == 4
    assert "2026-05-30" in summary.notifications_by_day


def test_digest_summary_defaults():
    """DigestSummary should have sensible defaults."""
    now = datetime.now(tz=UTC)
    summary = DigestSummary(user_id="u1", generated_at=now)
    assert summary.window_days == 7
    assert summary.total_spend == 0.0
    assert summary.top_categories == []
    assert summary.alert_count == 0
    assert summary.notifications_by_day == {}


# ── Idempotency key tests ─────────────────────────────────────────


def test_idempotency_key_deterministic():
    """Same inputs should produce the same key."""
    key1 = _idempotency_key("user-123", "2026-06-01")
    key2 = _idempotency_key("user-123", "2026-06-01")
    assert key1 == key2


def test_idempotency_key_varies_by_user():
    """Different users should produce different keys."""
    key1 = _idempotency_key("user-1", "2026-06-01")
    key2 = _idempotency_key("user-2", "2026-06-01")
    assert key1 != key2


def test_idempotency_key_varies_by_date():
    """Different dates should produce different keys."""
    key1 = _idempotency_key("user-1", "2026-06-01")
    key2 = _idempotency_key("user-1", "2026-06-02")
    assert key1 != key2


# ── Already-sent-today tests ──────────────────────────────────────


@pytest.mark.asyncio
async def test_already_sent_today_false_when_no_prior(db_session, free_user):
    """Should return False when no digest email exists."""
    result = await _already_sent_today(db_session, free_user.id, "2026-06-01")
    assert result is False


@pytest.mark.asyncio
async def test_already_sent_today_true_when_pending(db_session, free_user):
    """Should return True when a pending weekly_digest email exists for today."""
    queue_item = EmailQueue(
        id=str(uuid.uuid4()),
        user_id=free_user.id,
        to_email=free_user.email,
        subject="Weekly Digest",
        html="<p>test</p>",
        email_type="weekly_digest",
        status="pending",
        created_at=datetime.now(tz=UTC),
    )
    db_session.add(queue_item)
    await db_session.flush()

    date_str = datetime.now(tz=UTC).strftime("%Y-%m-%d")
    result = await _already_sent_today(db_session, free_user.id, date_str)
    assert result is True


# ── buildWeeklyDigest tests ────────────────────────────────────────


@pytest.mark.asyncio
async def test_buildWeeklyDigest_empty_when_no_notifs(db_session, free_user):
    """Should return a digest with no notifications when none exist."""
    summary = await buildWeeklyDigest(
        user_id=free_user.id,
        window_days=7,
        session=db_session,
    )
    assert summary.user_id == free_user.id
    assert summary.notifications_by_day == {}
    assert summary.alert_count == 0
    assert summary.top_categories == []


@pytest.mark.asyncio
async def test_buildWeeklyDigest_groups_by_day(db_session, free_user):
    """Should group notifications by day."""
    now = datetime.now(tz=UTC)

    for i in range(3):
        notif = Notification(
            id=str(uuid.uuid4()),
            user_id=free_user.id,
            notification_type="billing_reminder",
            title=f"Reminder {i}",
            body=f"Body {i}",
            created_at=now - timedelta(days=i),
        )
        db_session.add(notif)

    await db_session.flush()

    summary = await buildWeeklyDigest(
        user_id=free_user.id,
        window_days=7,
        session=db_session,
    )
    assert len(summary.notifications_by_day) >= 2
    assert summary.top_categories[0].category == "billing_reminder"
    assert summary.top_categories[0].count == 3


@pytest.mark.asyncio
async def test_buildWeeklyDigest_counts_alerts(db_session, free_user):
    """Should count billing_reminder and trial_expiring_soon as alerts."""
    now = datetime.now(tz=UTC)

    for ntype in ["billing_reminder", "trial_expiring_soon", "billing_reminder", "info"]:
        notif = Notification(
            id=str(uuid.uuid4()),
            user_id=free_user.id,
            notification_type=ntype,
            title="Title",
            body="Body",
            created_at=now,
        )
        db_session.add(notif)

    await db_session.flush()

    summary = await buildWeeklyDigest(
        user_id=free_user.id,
        window_days=7,
        session=db_session,
    )
    assert summary.alert_count == 3


@pytest.mark.asyncio
async def test_buildWeeklyDigest_nonexistent_user():
    """Should return empty digest for nonexistent user."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.database import make_async_engine

    engine = make_async_engine(echo=False)
    async_session = async_sessionmaker(engine, expire_on_commit=False)
    async with async_session() as session:
        summary = await buildWeeklyDigest(
            user_id="nonexistent-user-id",
            window_days=7,
            session=session,
        )
        assert summary.notifications_by_day == {}
        assert summary.alert_count == 0
    await engine.dispose()


# ── sendWeeklyDigestEmail tests ────────────────────────────────────


@pytest.mark.asyncio
async def test_sendWeeklyDigestEmail_queues_email(db_session, free_user):
    """Should queue a weekly digest email for a user with notifications."""
    now = datetime.now(tz=UTC)

    notif = Notification(
        id=str(uuid.uuid4()),
        user_id=free_user.id,
        notification_type="billing_reminder",
        title="Test reminder",
        body="Test body",
        created_at=now,
    )
    db_session.add(notif)
    await db_session.flush()

    summary = DigestSummary(
        user_id=free_user.id,
        window_days=7,
        top_categories=[CategoryCount(category="billing_reminder", count=1)],
        alert_count=1,
        notifications_by_day={
            now.strftime("%Y-%m-%d"): [
                NotificationDigestItem(
                    id=notif.id,
                    notification_type="billing_reminder",
                    title="Test reminder",
                    body="Test body",
                    read=False,
                    created_at=now,
                )
            ]
        },
        generated_at=now,
    )

    email_id = await sendWeeklyDigestEmail(
        user_id=free_user.id,
        summary=summary,
        session=db_session,
    )

    assert email_id is not None
    result = await db_session.execute(
        select(EmailQueue).where(EmailQueue.id == email_id)
    )
    queued = result.scalar_one()
    assert queued.email_type == "weekly_digest"
    assert queued.status == "pending"


@pytest.mark.asyncio
async def test_sendWeeklyDigestEmail_returns_none_for_no_email_user(db_session, free_user):
    """Should return None when user has no email."""
    free_user.email = None
    await db_session.flush()

    summary = DigestSummary(
        user_id=free_user.id,
        generated_at=datetime.now(tz=UTC),
    )

    email_id = await sendWeeklyDigestEmail(
        user_id=free_user.id,
        summary=summary,
        session=db_session,
    )
    assert email_id is None


# ── run_weekly_digest_for_user tests ──────────────────────────────


@pytest.mark.asyncio
async def test_run_weekly_digest_for_user_skips_empty(db_session, free_user):
    """Should skip when user has no notifications."""
    result = await run_weekly_digest_for_user(
        user_id=free_user.id,
        session=db_session,
    )
    assert result is None


@pytest.mark.asyncio
async def test_run_weekly_digest_for_user_sends_when_notifs_exist(db_session, free_user):
    """Should queue digest when notifications exist."""
    now = datetime.now(tz=UTC)

    notif = Notification(
        id=str(uuid.uuid4()),
        user_id=free_user.id,
        notification_type="billing_reminder",
        title="Reminder",
        body="Body",
        created_at=now,
    )
    db_session.add(notif)
    await db_session.flush()

    email_id = await run_weekly_digest_for_user(
        user_id=free_user.id,
        session=db_session,
    )
    assert email_id is not None


@pytest.mark.asyncio
async def test_run_weekly_digest_for_user_idempotent(db_session, free_user):
    """Should not send twice on the same day."""
    now = datetime.now(tz=UTC)

    notif = Notification(
        id=str(uuid.uuid4()),
        user_id=free_user.id,
        notification_type="billing_reminder",
        title="Reminder",
        body="Body",
        created_at=now,
    )
    db_session.add(notif)
    await db_session.flush()

    first = await run_weekly_digest_for_user(
        user_id=free_user.id,
        session=db_session,
    )
    assert first is not None

    second = await run_weekly_digest_for_user(
        user_id=free_user.id,
        session=db_session,
    )
    assert second is None


# ── enqueueWeeklyDigest tests ──────────────────────────────────────


@pytest.mark.asyncio
async def test_enqueueWeeklyDigest_queues_email(db_session, free_user):
    """Should enqueue a digest email via the email queue."""
    now = datetime.now(tz=UTC)

    notif = Notification(
        id=str(uuid.uuid4()),
        user_id=free_user.id,
        notification_type="billing_reminder",
        title="Reminder",
        body="Body",
        created_at=now,
    )
    db_session.add(notif)
    await db_session.flush()

    summary = DigestSummary(
        user_id=free_user.id,
        window_days=7,
        top_categories=[CategoryCount(category="billing_reminder", count=1)],
        alert_count=1,
        notifications_by_day={
            now.strftime("%Y-%m-%d"): [
                NotificationDigestItem(
                    id=notif.id,
                    notification_type="billing_reminder",
                    title="Reminder",
                    body="Body",
                    read=False,
                    created_at=now,
                )
            ]
        },
        generated_at=now,
    )

    email_id = await enqueueWeeklyDigest(userId=free_user.id, summary=summary, session=db_session)
    assert email_id is not None


@pytest.mark.asyncio
async def test_enqueueWeeklyDigest_rejects_bad_summary():
    """Should return None for non-DigestSummary input."""
    result = await enqueueWeeklyDigest(userId="u1", summary={"bad": True})
    assert result is None
