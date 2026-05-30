"""Pakalon Backend — FastAPI application factory."""

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.database import (
    DATABASE_UNAVAILABLE_DETAIL,
    initialize_database_if_needed,
    is_database_unavailable_error,
)

logger = logging.getLogger(__name__)

# if sys.platform == "win32":
#     asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan: startup + shutdown."""
    settings = get_settings()
    logger.info("Starting Pakalon Backend (%s)", settings.environment)

    # Initialize build configuration
    from app.build import initialize_build_config  # noqa: PLC0415
    build_config = initialize_build_config()

    # Initialize environment isolation
    from app.env import initialize_environment  # noqa: PLC0415
    initialize_environment(is_cloud=not settings.is_selfhosted)

    # Validate startup configuration
    from app.security import validate_startup  # noqa: PLC0415
    validation_result = validate_startup()
    if not validation_result["valid"]:
        logger.error("Startup validation failed")
        return

    # Initialize provider registry
    from app.providers import register_default_providers  # noqa: PLC0415
    register_default_providers()

    if settings.is_selfhosted:
        logger.info("Self-hosted mode enabled; cloud database and schedulers are disabled")
        interrupted = False
        try:
            yield
        except (asyncio.CancelledError, KeyboardInterrupt):
            interrupted = True
            logger.info("Self-hosted lifespan interrupted by shutdown signal")
        logger.info("Self-hosted backend shutting down")
        if interrupted:
            return
        return

    await initialize_database_if_needed()

    # Refresh models from OpenRouter on startup
    try:
        from app.jobs.model_refresh import run_model_refresh  # noqa: PLC0415

        await run_model_refresh()
        logger.info("Models refreshed from OpenRouter on startup")
    except Exception:
        logger.exception("Model refresh on startup failed; continuing with existing cache")

    # Start APScheduler background jobs
    from app.scheduler import scheduler  # noqa: PLC0415

    scheduler.start()
    logger.info("APScheduler started")

    # Initialise the unified automation scheduler (APScheduler or Trigger.dev)
    from app.services.scheduler_manager import automation_scheduler  # noqa: PLC0415

    automation_scheduler.init()
    scheduler_health = automation_scheduler.health()
    logger.info("Scheduler health: %s", scheduler_health)
    logger.info("Automation scheduler backend: %s", automation_scheduler.backend_name)

    from app.services.automations import restore_automation_jobs  # noqa: PLC0415

    try:
        await restore_automation_jobs()
        logger.info("Automation jobs restored")
    except Exception:
        logger.exception(
            "Automation job restoration failed during startup; continuing without scheduled automation rehydration"
        )

    interrupted = False
    try:
        yield  # ← server is running here
    except (asyncio.CancelledError, KeyboardInterrupt):
        # Uvicorn/Starlette can cancel lifespan while handling Ctrl+C or
        # reloader shutdown on Windows. Treat this as graceful shutdown.
        interrupted = True
        logger.info("Lifespan interrupted by shutdown signal; completing graceful teardown")

    # Shutdown
    try:
        if getattr(scheduler, "running", False):
            scheduler.shutdown(wait=False)
    except asyncio.CancelledError:
        logger.info("Scheduler shutdown cancelled during lifespan teardown")
    except Exception:
        logger.exception("Scheduler shutdown raised during lifespan teardown")

    logger.info("APScheduler stopped; backend shutting down")

    if interrupted:
        return


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = get_settings()

    app = FastAPI(
        title="Pakalon API",
        description="AI-Powered CLI Code Editor — Backend API",
        version="0.1.0",
        docs_url="/docs" if not settings.is_production else None,
        redoc_url="/redoc" if not settings.is_production else None,
        lifespan=lifespan,
    )

    # ── CORS ──────────────────────────────────────────────────
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_origin_regex=(
            r"https?://(localhost|127\.0\.0\.1)(:\d+)?$" if settings.is_development else None
        ),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Geo-blocking (T-A37) ─────────────────────────────────────
    from app.middleware.geo_block import GeoBlockMiddleware

    if not settings.is_selfhosted:
        app.add_middleware(GeoBlockMiddleware)

    # ── Self-hosted mode gate (defense in depth) ────────────────
    from app.middleware.mode import SelfHostedModeGate

    if settings.is_selfhosted:
        app.add_middleware(SelfHostedModeGate)

    # ── API key obfuscation middleware ──────────────────────────
    from app.middleware.api_key_obfuscation import ApiKeyObfuscationMiddleware

    app.add_middleware(ApiKeyObfuscationMiddleware)

    # ── Rate limiting middleware ────────────────────────────────
    from app.middleware.rate_limit import RateLimitMiddleware

    app.add_middleware(RateLimitMiddleware)

    # ── Routers ───────────────────────────────────────────────
    from app.routers import health, system

    app.include_router(health.router)
    app.include_router(system.router)

    if settings.is_selfhosted:
        from app.routers import local

        app.include_router(local.router)
    else:
        from app.routers import (
            admin,
            ai_proxy,
            audit,
            auth,
            automations,
            billing,
            credits,
            dashboard,
            figma,
            media,
            models,
            notifications,
            security,
            sessions,
            skills,
            support,
            tasks,
            teams,
            telemetry,
            tools,
            usage,
            users,
            webhooks,
        )

        app.include_router(auth.router)
        app.include_router(users.router)
        app.include_router(models.router)
        app.include_router(sessions.router)
        app.include_router(tasks.router)
        app.include_router(teams.router)
        app.include_router(usage.router)
        app.include_router(telemetry.router)
        app.include_router(billing.router)
        app.include_router(webhooks.router)
        app.include_router(support.router)
        app.include_router(tools.router)
        app.include_router(admin.router)
        app.include_router(ai_proxy.router)
        app.include_router(media.router)
        app.include_router(figma.router)
        app.include_router(audit.router)
        app.include_router(notifications.router)
        app.include_router(credits.router)
        app.include_router(dashboard.router)
        app.include_router(automations.router)
        app.include_router(skills.router)
        app.include_router(security.router)

    # ── Global exception handler ──────────────────────────────
    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        if is_database_unavailable_error(exc):
            logger.warning(
                "Database unavailable while handling %s %s: %s",
                request.method,
                request.url,
                exc,
            )
            return JSONResponse(
                status_code=503,
                content={"detail": DATABASE_UNAVAILABLE_DETAIL},
            )

        logger.exception("Unhandled exception on %s %s", request.method, request.url)
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error"},
        )

    return app


app = create_app()
