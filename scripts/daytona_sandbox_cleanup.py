#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from daytona import Daytona, ListSandboxesQuery

DELETABLE_STATES = {"stopped", "error", "build_failed", "archived", "destroyed"}


def sandbox_id(sandbox: Any) -> str:
    value = str(getattr(sandbox, "id", ""))
    assert value, "Daytona sandbox objects must expose a non-empty id"
    return value


def list_all_sandboxes(daytona: Daytona):
    # Daytona SDK 0.180.0 moved sandbox listing to cursor pagination.
    # Iterate through the SDK so workflow snapshot/cleanup sees every sandbox.
    yield from daytona.list(ListSandboxesQuery(limit=100))


def normalized_state(sandbox: Any) -> str:
    # Daytona returns SandboxState enums; use values so active sandboxes are never deleted.
    state = getattr(sandbox, "state", "")
    return str(getattr(state, "value", state)).lower()


def snapshot(daytona: Daytona) -> None:
    ids = [sandbox_id(sandbox) for sandbox in list_all_sandboxes(daytona)]
    print("\n".join(ids))


def cleanup(daytona: Daytona, pre_existing_file: Path) -> None:
    pre_existing = {line.strip() for line in pre_existing_file.read_text().splitlines() if line.strip()}
    candidates = [
        sandbox
        for sandbox in list_all_sandboxes(daytona)
        if sandbox_id(sandbox) not in pre_existing
    ]
    to_delete = [sandbox for sandbox in candidates if normalized_state(sandbox) in DELETABLE_STATES]
    skipped = len(candidates) - len(to_delete)
    if skipped:
        print(f"Skipping {skipped} active or transitional sandbox(es)")
    if not to_delete:
        print("No stopped or errored sandboxes to clean up")
        return

    print(f"Cleaning up {len(to_delete)} stopped or errored sandbox(es) from this run...")
    for sandbox in to_delete:
        sandbox_identifier = sandbox_id(sandbox)
        state = getattr(sandbox, "state", "unknown")
        try:
            print(f"  Deleting {sandbox_identifier} (state={state})...")
            daytona.delete(sandbox)
            print(f"  Deleted {sandbox_identifier}")
        except Exception as exc:
            print(f"  Failed to delete {sandbox_identifier}: {exc}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Snapshot or cleanup Daytona sandboxes for tbench workflows.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("snapshot")
    cleanup_parser = subparsers.add_parser("cleanup")
    cleanup_parser.add_argument("--pre-existing-file", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    daytona = Daytona()
    if args.command == "snapshot":
        snapshot(daytona)
        return 0
    if args.command == "cleanup":
        cleanup(daytona, args.pre_existing_file)
        return 0
    raise AssertionError(f"Unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
