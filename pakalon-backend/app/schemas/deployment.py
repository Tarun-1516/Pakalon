"""Pydantic schemas for deployment mode endpoints."""

from pydantic import BaseModel


class DeploymentModeInfo(BaseModel):
    """Response schema for the deployment-mode endpoint."""

    mode: str
    is_cloud: bool
    is_self_hosted: bool
    features: list[str]
    restrictions: list[str]


class DeploymentModeToggleRequest(BaseModel):
    """Request body for toggling deployment mode (admin-only)."""

    mode: str
