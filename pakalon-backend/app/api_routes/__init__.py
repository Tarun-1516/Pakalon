"""Top-level router aggregator for all new feature routers."""
from __future__ import annotations

from fastapi import APIRouter

from app.mnemopi.router import router as mnemopi_router
from app.hindsight.router import router as hindsight_router
from app.compaction.router import router as compaction_router
from app.goals.router import router as goals_router
from app.commit.router import router as commit_router
from app.internal_urls.router import router as internal_urls_router
from app.pty.router import router as pty_router
from app.dap.router import router as dap_router
from app.ssh.router import router as ssh_router
from app.worktree.router import router as worktree_router
from app.worktree.v2_router import router as worktree_v2_router
from app.auth.router import router as auth_router
from app.auth.device_code.router import router as device_code_router
from app.llm_providers.router import router as providers_router
# Direct HTTP-callable provider implementations (additive on top of catalog)
from app.llm_providers.direct.router import router as llm_direct_router
# Additive memory layer (retain/recall/reflect + vector store adapter)
from app.memory.router import router as memory_router
from app.image_models.router import router as image_models_router
from app.acp.router import router as acp_router
from app.sessions_v2.router import router as sessions_v2_router
from app.snapshots.router import router as snapshots_router
from app.patches.router import router as patches_router
from app.shares.router import router as shares_router
from app.projects.router import router as projects_router
from app.mcp_oauth.router import router as mcp_oauth_router
from app.bootstrap.router import router as bootstrap_router
from app.eval.router import router as eval_router
from app.eval.v2_router import router as eval_v2_router
from app.tiny.router import router as tiny_router
from app.scrapers.router import router as scrapers_router
from app.btw.router import router as btw_router
from app.session_observer.router import router as session_observer_router
from app.modes.router import router as modes_router
from app.dashboard.router import router as dashboard_router
# 6-phase orchestration (comparison.md Module 1)
from app.routers.phase_runs import router as phase_runs_router
# Sub-agent execution (comparison.md Module 2)
from app.routers.sub_agents import router as sub_agents_router
# Auditor agent (comparison.md Module 3)
from app.routers.auditor import router as auditor_router
# Penpot wireframe sync (comparison.md Module 4)
from app.routers.penpot import router as penpot_router
# Telegram + Supabase bridge (comparison.md Module 5)
from app.routers.bridge import router as bridge_router
# Sandbox lifecycle (comparison.md Module 6)
from app.routers.sandbox import router as sandbox_router
# Web search chain (14 backends; chain.py + router.py)
from app.web_search.router import router as web_search_router

api_router = APIRouter()
api_router.include_router(mnemopi_router)
api_router.include_router(hindsight_router)
api_router.include_router(compaction_router)
api_router.include_router(goals_router)
api_router.include_router(commit_router)
api_router.include_router(internal_urls_router)
api_router.include_router(pty_router)
api_router.include_router(dap_router)
api_router.include_router(ssh_router)
api_router.include_router(worktree_router)
api_router.include_router(worktree_v2_router)
api_router.include_router(auth_router)
api_router.include_router(device_code_router)
api_router.include_router(providers_router)
api_router.include_router(llm_direct_router)
api_router.include_router(memory_router)
api_router.include_router(image_models_router)
api_router.include_router(acp_router)
api_router.include_router(sessions_v2_router)
api_router.include_router(snapshots_router)
api_router.include_router(patches_router)
api_router.include_router(shares_router)
api_router.include_router(projects_router)
api_router.include_router(mcp_oauth_router)
api_router.include_router(bootstrap_router)
api_router.include_router(eval_router)
api_router.include_router(eval_v2_router)
api_router.include_router(tiny_router)
api_router.include_router(scrapers_router)
api_router.include_router(btw_router)
api_router.include_router(session_observer_router)
api_router.include_router(modes_router)
api_router.include_router(dashboard_router)
# 6-phase orchestration (comparison.md Module 1)
api_router.include_router(phase_runs_router)
# Sub-agent execution (comparison.md Module 2)
api_router.include_router(sub_agents_router)
# Auditor agent (comparison.md Module 3)
api_router.include_router(auditor_router)
# Penpot wireframe sync (comparison.md Module 4)
api_router.include_router(penpot_router)
# Telegram + Supabase bridge (comparison.md Module 5)
api_router.include_router(bridge_router)
# Sandbox lifecycle (comparison.md Module 6)
api_router.include_router(sandbox_router)
# Web search chain (14 backends; chain.py + router.py)
api_router.include_router(web_search_router)

__all__ = ["api_router"]
