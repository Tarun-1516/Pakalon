"""Image generation model catalog."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Flag, auto
from typing import Any


class ImageCapability(Flag):
    TEXT_TO_IMAGE = auto()
    IMAGE_TO_IMAGE = auto()
    INPAINTING = auto()
    UPSCALE = auto()
    EDIT = auto()


@dataclass(slots=True)
class ImageModel:
    id: str
    name: str
    provider: str
    capabilities: ImageCapability
    max_resolution: int = 1024
    cost_per_image: float = 0.0


IMAGE_MODELS: list[ImageModel] = [
    ImageModel("dall-e-3", "DALL·E 3", "openai", ImageCapability.TEXT_TO_IMAGE | ImageCapability.EDIT, 1024, 0.040),
    ImageModel("dall-e-2", "DALL·E 2", "openai", ImageCapability.TEXT_TO_IMAGE | ImageCapability.IMAGE_TO_IMAGE | ImageCapability.INPAINTING, 1024, 0.020),
    ImageModel("gpt-image-1", "GPT Image 1", "openai", ImageCapability.TEXT_TO_IMAGE | ImageCapability.IMAGE_TO_IMAGE | ImageCapability.EDIT, 1024, 0.040),
    ImageModel("imagen-3.0-generate-002", "Imagen 3", "google", ImageCapability.TEXT_TO_IMAGE, 2048, 0.040),
    ImageModel("imagen-3.0-fast-generate-001", "Imagen 3 Fast", "google", ImageCapability.TEXT_TO_IMAGE, 1024, 0.020),
    ImageModel("gemini-2.0-flash-exp-image", "Gemini 2.0 Flash Image", "google", ImageCapability.TEXT_TO_IMAGE | ImageCapability.EDIT, 1024, 0.020),
    ImageModel("black-forest-labs/FLUX-1.1-pro", "FLUX 1.1 Pro", "black-forest-labs", ImageCapability.TEXT_TO_IMAGE, 2048, 0.040),
    ImageModel("black-forest-labs/FLUX-1-schnell", "FLUX 1 Schnell", "black-forest-labs", ImageCapability.TEXT_TO_IMAGE, 1024, 0.0),
    ImageModel("stability-ai/sdxl", "Stable Diffusion XL", "stability-ai", ImageCapability.TEXT_TO_IMAGE | ImageCapability.IMAGE_TO_IMAGE, 1024, 0.020),
    ImageModel("stability-ai/sd3", "Stable Diffusion 3", "stability-ai", ImageCapability.TEXT_TO_IMAGE, 1024, 0.030),
    ImageModel("ideogram-2.0", "Ideogram 2.0", "ideogram", ImageCapability.TEXT_TO_IMAGE, 2048, 0.080),
    ImageModel("recraft-v3", "Recraft v3", "recraft", ImageCapability.TEXT_TO_IMAGE, 2048, 0.080),
    ImageModel("minimax-image-01", "MiniMax Image-01", "minimax", ImageCapability.TEXT_TO_IMAGE, 1024, 0.020),
    ImageModel("kandinsky-3", "Kandinsky 3", "sber", ImageCapability.TEXT_TO_IMAGE, 1024, 0.020),
    ImageModel("playground-v2.5", "Playground v2.5", "playground", ImageCapability.TEXT_TO_IMAGE, 1024, 0.020),
    ImageModel("leonardo-phoenix", "Leonardo Phoenix", "leonardo", ImageCapability.TEXT_TO_IMAGE | ImageCapability.IMAGE_TO_IMAGE, 1024, 0.020),
]


def list_image_models() -> list[dict[str, Any]]:
    return [
        {
            "id": m.id, "name": m.name, "provider": m.provider,
            "max_resolution": m.max_resolution,
            "cost_per_image": m.cost_per_image,
            "capabilities": [c.name for c in ImageCapability if c in m.capabilities],
        }
        for m in IMAGE_MODELS
    ]


def get_image_model(model_id: str) -> ImageModel | None:
    return next((m for m in IMAGE_MODELS if m.id == model_id), None)
