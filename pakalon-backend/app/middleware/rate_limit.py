"""Rate limiting middleware for Pakalon backend.

Provides rate limiting based on user tier and endpoint type.
Supports both database-backed and in-memory rate limiting.
"""
import logging
import time
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Callable, Any

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

import json
import jwt
from app.config import get_settings
from app.features import get_feature_flags

logger = logging.getLogger(__name__)

# Route-specific overrides: (method, path_prefix) → requests_per_minute
ROUTE_LIMITS: dict[tuple[str, str], int] = {
    ("POST", "/auth/devices"): 10,        # prevent device code spam
    ("POST", "/auth/confirm"): 20,        # confirm code endpoint
    ("POST", "/billing"): 30,             # checkout
    ("POST", "/webhooks"): 200,           # webhooks can be high volume
    ("POST", "/sessions"): 50,            # session creation
    ("GET", "/sessions"): 5000,           # CLI session polling/listing - increased to prevent 429 during retry loops
}

# Plan-based limits for AI proxy endpoints (T-BE-22)
# Keyed by (method, path_prefix) → { plan → req/min }
AI_PLAN_LIMITS: dict[tuple[str, str], dict[str, int]] = {
    ("POST", "/ai/chat"): {"free": 60, "pro": 300, "default": 60},
}

DEFAULT_LIMIT = 100  # requests per minute per IP


class RateLimitConfig:
    """Configuration for rate limiting."""

    # Default limits per tier
    DEFAULT_LIMITS = {
        "free": {
            "requests_per_minute": 30,
            "requests_per_hour": 500,
            "tokens_per_day": 100_000,
        },
        "pro": {
            "requests_per_minute": 100,
            "requests_per_hour": 2000,
            "tokens_per_day": 1_000_000,
        },
    }

    # Endpoint-specific limits
    ENDPOINT_LIMITS = {
        "/chat": {"requests_per_minute": 20},
        "/models": {"requests_per_minute": 60},
        "/health": {"requests_per_minute": 120},
    }


class InMemoryRateLimiter:
    """In-memory rate limiter for self-hosted mode."""

    def __init__(self):
        self._requests: dict[str, list[float]] = defaultdict(list)
        self._tokens: dict[str, int] = defaultdict(int)
        self._last_reset: dict[str, datetime] = {}

    def _get_key(self, user_id: str, endpoint: str) -> str:
        """Generate rate limit key."""
        return f"{user_id}:{endpoint}"

    def _cleanup_old_requests(self, key: str, window_seconds: int) -> None:
        """Remove requests older than the window."""
        cutoff = time.time() - window_seconds
        self._requests[key] = [t for t in self._requests[key] if t > cutoff]

    def check_rate_limit(
        self,
        user_id: str,
        endpoint: str,
        tier: str = "free",
        limit_type: str = "requests_per_minute",
    ) -> tuple[bool, dict[str, Any]]:
        """Check if request is within rate limit."""
        config = RateLimitConfig.DEFAULT_LIMITS.get(tier, RateLimitConfig.DEFAULT_LIMITS["free"])
        limit = config.get(limit_type, 30)

        key = self._get_key(user_id, endpoint)
        window = 60 if "minute" in limit_type else 3600

        self._cleanup_old_requests(key, window)
        current_count = len(self._requests[key])

        headers = {
            "X-RateLimit-Limit": str(limit),
            "X-RateLimit-Remaining": str(max(0, limit - current_count)),
            "X-RateLimit-Reset": str(int(time.time() + window)),
        }

        if current_count >= limit:
            return False, headers

        self._requests[key].append(time.time())
        return True, headers

    def record_tokens(self, user_id: str, tokens: int) -> None:
        """Record token usage."""
        self._tokens[user_id] += tokens

    def get_token_usage(self, user_id: str) -> int:
        """Get total token usage for user."""
        return self._tokens.get(user_id, 0)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Rate limiter with support for both database-backed and in-memory modes."""

    def __init__(self, app, redis_url: str | None = None) -> None:
        super().__init__(app)
        self._settings = get_settings()
        self._memory_limiter = InMemoryRateLimiter()
        self._flags = get_feature_flags()

    def _get_limit(self, method: str, path: str, plan: str | None = None) -> int:
        """Get rate limit for endpoint."""
        # Check plan-based AI limits first (T-BE-22)
        for (m, prefix), plan_limits in AI_PLAN_LIMITS.items():
            if method == m and path.startswith(prefix):
                effective_plan = plan or "free"
                return plan_limits.get(effective_plan, plan_limits["default"])
        for (m, prefix), limit in ROUTE_LIMITS.items():
            if method == m and path.startswith(prefix):
                return limit
        return DEFAULT_LIMIT

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        settings = get_settings()
        flags = get_feature_flags()

        # Skip rate limiting in self-hosted mode (use in-memory limiter instead)
        if settings.is_selfhosted:
            return await self._dispatch_selfhosted(request, call_next)

        # Skip rate limiting if not enabled
        if not flags.rate_limiting:
            return await call_next(request)

        client_ip = request.client.host if request.client else "unknown"
        path = request.url.path
        method = request.method

        # Skip rate limiting for health check
        if path == "/health":
            return await call_next(request)

        # Extract user_id from JWT if present
        user_id = None
        user_plan = None
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header[7:]
            try:
                payload = jwt.decode(token, options={"verify_signature": False})
                user_id = payload.get("sub")
                user_plan = payload.get("plan")  # T-BE-22: plan claim for rate limit
            except Exception:
                pass

        # Extract model_id from path or body if applicable
        model_id = None
        if path.startswith("/models/") and "/context" in path:
            parts = path.split("/")
            if len(parts) >= 3:
                model_id = parts[2]
        elif method == "POST" and path == "/sessions":
            try:
                body = await request.body()
                if body:
                    data = json.loads(body)
                    model_id = data.get("model_id")
                # Put the body back so the route handler can read it
                async def receive():
                    return {"type": "http.request", "body": body}
                request._receive = receive
            except Exception:
                pass

        limit = self._get_limit(method, path, plan=user_plan)
        
        # Build a more specific key if we have user/model info
        if user_id and model_id:
            key = f"rl:user:{user_id}:model:{model_id}:{method}:{path}"
        elif user_id:
            key = f"rl:user:{user_id}:{method}:{path}"
        else:
            key = f"rl:ip:{client_ip}:{method}:{path}"

        try:
            from app.database import AsyncSessionLocal  # noqa: PLC0415
            from app.services.rate_limit import check_rate_limit, rate_limit_headers  # noqa: PLC0415

            async with AsyncSessionLocal() as session:
                allowed, remaining, retry_after = await check_rate_limit(
                    session,
                    user_id or client_ip,
                    user_plan or "free",
                    route_key=f"{method}:{path}",
                    limit_override=limit,
                )
                if not allowed:
                    return JSONResponse(
                        status_code=429,
                        content={"detail": f"Rate limit exceeded: {limit} req/min"},
                        headers=rate_limit_headers(remaining, limit, retry_after),
                    )
                await session.commit()
        except Exception as exc:
            logger.warning("Rate limiter error (skipping): %s", exc)

        return await call_next(request)

    async def _dispatch_selfhosted(self, request: Request, call_next: Callable) -> Response:
        """Dispatch with in-memory rate limiting for self-hosted mode."""
        path = request.url.path
        method = request.method

        # Skip rate limiting for health check
        if path == "/health":
            return await call_next(request)

        # Use simple in-memory rate limiting
        user_id = "selfhosted_user"
        tier = "free"

        allowed, headers = self._memory_limiter.check_rate_limit(user_id, path, tier)

        if not allowed:
            logger.warning(f"Rate limit exceeded for self-hosted user on {path}")
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded"},
                headers=headers,
            )

        response = await call_next(request)

        # Add rate limit headers
        for key, value in headers.items():
            response.headers[key] = value

        return response
