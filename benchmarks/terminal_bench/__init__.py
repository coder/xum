from __future__ import annotations

__all__ = ["MuxAgent"]


def __getattr__(name: str):
    if name == "MuxAgent":
        from .mux_agent import MuxAgent

        return MuxAgent
    raise AttributeError(name)
