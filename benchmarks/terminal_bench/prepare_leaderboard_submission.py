#!/usr/bin/env python3
"""
Prepare Terminal-Bench results for leaderboard submission.

This script:
1. Downloads nightly benchmark results from GitHub Actions
2. Constructs the submission folder structure required by the leaderboard
3. Prints instructions to submit via `hf` CLI

The leaderboard computes pass@k from multiple attempts per task. Provide
multiple runs (via --run-id or --n-runs) so each becomes its own job folder
inside the submission. For example, 5 separate 1×89-trial runs produce the
same structure as a single n_attempts=5 run with 445 trials.

Usage:
    # Download latest 5 successful nightly runs (recommended for submission)
    python prepare_leaderboard_submission.py --n-runs 5

    # Use specific run IDs (each becomes a job folder)
    python prepare_leaderboard_submission.py --run-id 111 222 333 444 555

    # Use existing downloaded artifacts directories
    python prepare_leaderboard_submission.py --artifacts-dir ./run1 ./run2 ./run3

    # Download latest single run (quick iteration)
    python prepare_leaderboard_submission.py

    # Then submit with hf CLI:
    hf upload alexgshaw/terminal-bench-2-leaderboard \\
        ./leaderboard_submission/submissions submissions \\
        --repo-type dataset --create-pr --commit-message "Mux submission"

Output structure (per leaderboard requirements):
    submissions/terminal-bench/2.0/Mux__<Model>/
        metadata.yaml
        <job-folder-1>/             # From run 1 (e.g., 2026-02-01__00-15-05)
            config.json
            result.json
            <trial-1>/             # e.g., chess-best-move__ABC123
                config.json
                result.json
                agent/
                verifier/
            ...
        <job-folder-2>/             # From run 2
            ...
"""

import argparse
import json
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

try:
    from .tbench_utils import (
        download_run_artifacts,
        list_artifacts_for_run,
        list_nightly_runs,
    )
except ImportError:
    from tbench_utils import (  # type: ignore[import-not-found,no-redef]
        download_run_artifacts,
        list_artifacts_for_run,
        list_nightly_runs,
    )

# HuggingFace leaderboard repo
LEADERBOARD_REPO = "alexgshaw/terminal-bench-2-leaderboard"


# Agent metadata for Mux
MUX_METADATA = {
    "agent_url": "https://github.com/coder/mux",
    "agent_display_name": "Mux",
    "agent_org_display_name": "Coder",
}

# Model metadata lookup
# folder_name: Used in submission folder path (e.g., Mux__Claude-Opus-4.5)
MODEL_METADATA = {
    "anthropic/claude-sonnet-4-5": {
        "model_name": "claude-sonnet-4-5",
        "model_provider": "anthropic",
        "model_display_name": "Claude Sonnet 4.5",
        "model_org_display_name": "Anthropic",
        "folder_name": "Claude-Sonnet-4.5",
    },
    "anthropic/claude-opus-4-5": {
        "model_name": "claude-opus-4-5",
        "model_provider": "anthropic",
        "model_display_name": "Claude Opus 4.5",
        "model_org_display_name": "Anthropic",
        "folder_name": "Claude-Opus-4.5",
    },
    "anthropic/claude-opus-4-6": {
        "model_name": "claude-opus-4-6",
        "model_provider": "anthropic",
        "model_display_name": "Claude Opus 4.6",
        "model_org_display_name": "Anthropic",
        "folder_name": "Claude-Opus-4.6",
    },
    "anthropic/claude-opus-4-7": {
        "model_name": "claude-opus-4-7",
        "model_provider": "anthropic",
        "model_display_name": "Claude Opus 4.7",
        "model_org_display_name": "Anthropic",
        "folder_name": "Claude-Opus-4.7",
    },
    "anthropic/claude-opus-4-8": {
        "model_name": "claude-opus-4-8",
        "model_provider": "anthropic",
        "model_display_name": "Claude Opus 4.8",
        "model_org_display_name": "Anthropic",
        "folder_name": "Claude-Opus-4.8",
    },
    "anthropic/claude-opus-5": {
        "model_name": "claude-opus-5",
        "model_provider": "anthropic",
        "model_display_name": "Claude Opus 5",
        "model_org_display_name": "Anthropic",
        "folder_name": "Claude-Opus-5",
    },
    # Keep historical GPT metadata alongside the current GPT-5.6 Sol bench target
    # so mixed or older artifact sets still map to the canonical leaderboard names.
    "openai/gpt-5.2": {
        "model_name": "gpt-5.2",
        "model_provider": "openai",
        "model_display_name": "GPT-5.2",
        "model_org_display_name": "OpenAI",
        "folder_name": "GPT-5.2",
    },
    "openai/gpt-5.4": {
        "model_name": "gpt-5.4",
        "model_provider": "openai",
        "model_display_name": "GPT-5.4",
        "model_org_display_name": "OpenAI",
        "folder_name": "GPT-5.4",
    },
    "openai/gpt-5.5": {
        "model_name": "gpt-5.5",
        "model_provider": "openai",
        "model_display_name": "GPT-5.5",
        "model_org_display_name": "OpenAI",
        "folder_name": "GPT-5.5",
    },
    "openai/gpt-5.6-sol": {
        "model_name": "gpt-5.6-sol",
        "model_provider": "openai",
        "model_display_name": "GPT-5.6 Sol",
        "model_org_display_name": "OpenAI",
        "folder_name": "GPT-5.6-Sol",
    },
    "openai/gpt-5-codex": {
        "model_name": "gpt-5-codex",
        "model_provider": "openai",
        "model_display_name": "GPT-5 Codex",
        "model_org_display_name": "OpenAI",
        "folder_name": "GPT-5-Codex",
    },
    "openai/gpt-5.3-codex": {
        "model_name": "gpt-5.3-codex",
        "model_provider": "openai",
        "model_display_name": "GPT-5.3 Codex",
        "model_org_display_name": "OpenAI",
        "folder_name": "GPT-5.3-Codex",
    },
}


def get_latest_successful_nightly_run() -> dict | None:
    """Get the latest successful nightly Terminal-Bench run."""
    print("Fetching latest successful nightly run...")
    runs = list_nightly_runs(limit=1, status="success", verbose=True)
    if not runs:
        print("No successful nightly runs found")
        return None
    return runs[0]


def create_metadata_yaml(model: str) -> str:
    """Create the metadata.yaml content for a submission."""
    model_info = MODEL_METADATA.get(model)
    if not model_info:
        print(f"Warning: Unknown model {model}, using defaults")
        model_info = {
            "model_name": model.split("/")[-1],
            "model_provider": model.split("/")[0],
            "model_display_name": model.split("/")[-1],
            "model_org_display_name": model.split("/")[0].title(),
        }

    lines = [
        f'agent_url: "{MUX_METADATA["agent_url"]}"',
        f'agent_display_name: "{MUX_METADATA["agent_display_name"]}"',
        f'agent_org_display_name: "{MUX_METADATA["agent_org_display_name"]}"',
        "",
        "models:",
        f'  - model_name: "{model_info["model_name"]}"',
        f'    model_provider: "{model_info["model_provider"]}"',
        f'    model_display_name: "{model_info["model_display_name"]}"',
        f'    model_org_display_name: "{model_info["model_org_display_name"]}"',
    ]

    return "\n".join(lines) + "\n"


def get_model_from_config(config_path: Path) -> str | None:
    """Extract model name from config.json."""
    try:
        config = json.loads(config_path.read_text())
        return config.get("agent", {}).get("model_name")
    except (json.JSONDecodeError, OSError):
        return None


def _child_dirs(path: Path) -> list[Path]:
    """List the immediate subdirectories of a directory, skipping plain files."""
    return [child for child in path.iterdir() if child.is_dir()]


def _is_job_folder(path: Path) -> bool:
    """Check if a directory looks like a job folder (contains trial dirs with config.json)."""
    if not path.is_dir():
        return False
    # A job folder has trial subdirs named <task>__<hash> and/or a config.json
    if (path / "config.json").exists():
        return True
    # Check if any child looks like a trial directory
    return any(
        child.is_dir() and "__" in child.name and (child / "result.json").exists()
        for child in path.iterdir()
    )


def find_job_folders(artifacts_dir: Path) -> list[Path]:
    """
    Find all job folders (containing trial directories) in the artifacts.

    Handles multiple structures:
    1. Direct job folder: artifacts_dir itself contains trials (e.g., extracted tar)
    2. Jobs parent: artifacts_dir/jobs/YYYY-MM-DD__HH-MM-SS/
    3. Per-artifact: artifacts_dir/<artifact-name>/jobs/YYYY-MM-DD__HH-MM-SS/
    """
    job_folders = []

    # Check if artifacts_dir itself is a job folder (common when pointing at an
    # extracted tarball or a raw job directory like /path/to/2026-02-08__19-57-27/)
    if _is_job_folder(artifacts_dir):
        return [artifacts_dir]

    # Check for direct jobs/ folder
    direct_jobs = artifacts_dir / "jobs"
    if direct_jobs.exists():
        job_folders.extend(_child_dirs(direct_jobs))
        return job_folders

    # Check for per-artifact structure
    for artifact_dir in _child_dirs(artifacts_dir):
        jobs_dir = artifact_dir / "jobs"
        if jobs_dir.exists():
            job_folders.extend(_child_dirs(jobs_dir))

    return job_folders


def prepare_submission(
    artifacts_dir: Path,
    output_dir: Path,
    models_filter: list[str] | None = None,
) -> dict[str, Path]:
    """
    Prepare submission folders from downloaded artifacts.

    Leaderboard structure:
        submissions/terminal-bench/2.0/<agent>__<model>/
            metadata.yaml
            <job-folder>/           # Timestamp-named (e.g., 2026-01-16__00-15-05)
                config.json
                result.json
                <trial-folder>/     # e.g., chess-best-move__ABC123
                    config.json
                    result.json
                    agent/
                    verifier/

    Returns a dict mapping model names to their submission directories.
    """
    submissions: dict[str, Path] = {}

    # Find all job folders in the artifacts
    job_folders = find_job_folders(artifacts_dir)
    if not job_folders:
        print("No job folders found in artifacts")
        return submissions

    print(f"Found {len(job_folders)} job folder(s)")

    # Group trials by model
    model_trials: dict[
        str, list[tuple[Path, Path]]
    ] = {}  # model -> [(trial_src, job_folder)]
    model_jobs: dict[str, dict[str, Path]] = {}  # model -> {job_name: job_folder}

    for job_folder in job_folders:
        for trial_folder in job_folder.iterdir():
            if not trial_folder.is_dir():
                continue

            config_path = trial_folder / "config.json"
            result_path = trial_folder / "result.json"

            if not result_path.exists():
                continue

            # Get model from config
            model = get_model_from_config(config_path) if config_path.exists() else None
            if not model:
                print(f"  Warning: Could not determine model for {trial_folder.name}")
                continue

            if model not in model_trials:
                model_trials[model] = []
                model_jobs[model] = {}
            model_trials[model].append((trial_folder, job_folder))
            model_jobs[model][job_folder.name] = job_folder

    # Filter models if specified
    if models_filter:
        model_trials = {m: t for m, t in model_trials.items() if m in models_filter}

    # Create submissions for each model
    for model, trials in model_trials.items():
        # Create submission directory: Mux__<Model>
        model_info = MODEL_METADATA.get(model, {})
        model_folder_name = model_info.get("folder_name", model.split("/")[-1].title())
        submission_name = f"Mux__{model_folder_name}"

        submission_dir = (
            output_dir / "submissions" / "terminal-bench" / "2.0" / submission_name
        )
        submission_dir.mkdir(parents=True, exist_ok=True)

        # Create metadata.yaml
        metadata_path = submission_dir / "metadata.yaml"
        if not metadata_path.exists():
            metadata_path.write_text(create_metadata_yaml(model))

        # Group trials by source job folder (preserve original job structure)
        trials_by_job: dict[str, list[Path]] = {}
        for trial_src, job_folder in trials:
            job_name = job_folder.name
            if job_name not in trials_by_job:
                trials_by_job[job_name] = []
            trials_by_job[job_name].append(trial_src)

        # Copy trials into job folders
        total_trials = 0
        for job_name, trial_paths in trials_by_job.items():
            dest_job_folder = submission_dir / job_name
            dest_job_folder.mkdir(parents=True, exist_ok=True)

            # Copy job-level config/result if present
            job_root = model_jobs[model].get(job_name)
            if job_root:
                for filename in ("config.json", "result.json"):
                    source_file = job_root / filename
                    if source_file.exists():
                        shutil.copy2(source_file, dest_job_folder / filename)

            for trial_src in trial_paths:
                dest_trial_dir = dest_job_folder / trial_src.name
                if dest_trial_dir.exists():
                    shutil.rmtree(dest_trial_dir)
                shutil.copytree(
                    trial_src,
                    dest_trial_dir,
                    ignore=shutil.ignore_patterns(
                        "mux-app.tar.gz",  # Large agent binary (~5MB each)
                        "mux-tokens.json",  # Token usage (not needed for leaderboard)
                        "*.log",  # Log files trigger HF LFS and cause upload timeouts
                    ),
                )
                total_trials += 1

        print(f"  {model}: copied {total_trials} trial(s)")
        submissions[model] = submission_dir

    return submissions


def download_run_to_dir(
    run_id: int,
    models_filter: list[str] | None,
    verbose: bool = True,
) -> tuple[Path, str]:
    """Download artifacts for a single GH Actions run.

    Returns (artifacts_dir, run_date).
    """
    run_info = {"databaseId": run_id, "createdAt": datetime.now().isoformat()}

    run_date = run_info["createdAt"][:10]
    print(f"Using run {run_id} from {run_date}")

    artifacts = list_artifacts_for_run(run_id, verbose=verbose)
    if not artifacts:
        print(f"No terminal-bench artifacts found for run {run_id}")
        sys.exit(1)

    print(f"Found {len(artifacts)} artifact(s)")

    if models_filter:
        artifacts = [
            a
            for a in artifacts
            if any(m.replace("/", "-") in a["name"] for m in models_filter)
        ]
        print(f"Filtered to {len(artifacts)} artifact(s) for specified models")

    artifacts_dir = Path(tempfile.mkdtemp(prefix="tbench-"))
    artifact_names = [a["name"] for a in artifacts]
    if not download_run_artifacts(
        run_id, artifacts_dir, artifact_names, verbose=verbose
    ):
        print(f"Failed to download artifacts for run {run_id}")
        sys.exit(1)

    return artifacts_dir, run_date


def main():
    parser = argparse.ArgumentParser(
        description="Prepare Terminal-Bench results for leaderboard submission"
    )
    parser.add_argument(
        "--run-id",
        type=int,
        nargs="+",
        help="One or more GitHub Actions run IDs (each becomes a job folder)",
    )
    parser.add_argument(
        "--artifacts-dir",
        type=Path,
        nargs="+",
        help="One or more existing artifact directories",
    )
    parser.add_argument(
        "--n-runs",
        type=int,
        default=None,
        help="Automatically fetch the latest N successful nightly runs (e.g., --n-runs 5)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("leaderboard_submission"),
        help="Output directory for submission (default: leaderboard_submission)",
    )
    parser.add_argument(
        "--models",
        nargs="+",
        help="Only process specific models (e.g., anthropic/claude-opus-5, openai/gpt-5.6-sol)",
    )
    args = parser.parse_args()

    # Collect all artifact directories to merge into one submission.
    # Each source (run-id, artifacts-dir, or auto-discovered nightly run) is
    # downloaded/validated independently, then all are fed into
    # prepare_submission() which preserves each job folder as a separate entry.
    artifacts_dirs: list[Path] = []
    run_date = datetime.now().strftime("%Y-%m-%d")
    temp_dirs: list[Path] = []

    if args.artifacts_dir:
        for d in args.artifacts_dir:
            if not d.exists():
                print(f"Error: Artifacts directory {d} does not exist")
                sys.exit(1)
            artifacts_dirs.append(d)

    if args.run_id:
        for rid in args.run_id:
            ad, rd = download_run_to_dir(rid, args.models)
            artifacts_dirs.append(ad)
            temp_dirs.append(ad)
            run_date = rd

    if args.n_runs is not None:
        # Auto-discover latest N successful nightly runs
        n = args.n_runs
        print(f"Fetching latest {n} successful nightly run(s)...")
        runs = list_nightly_runs(limit=n, status="success", verbose=True)
        if len(runs) < n:
            print(
                f"Warning: only found {len(runs)} successful nightly run(s) "
                f"(requested {n})"
            )
        if not runs:
            print("No successful nightly runs found")
            sys.exit(1)
        run_date = runs[0]["createdAt"][:10]
        for run_info in runs:
            rid = run_info["databaseId"]
            ad, _ = download_run_to_dir(rid, args.models)
            artifacts_dirs.append(ad)
            temp_dirs.append(ad)

    # Default: latest single nightly run
    if not artifacts_dirs:
        run_info = get_latest_successful_nightly_run()
        if not run_info:
            print("Could not find a successful nightly run")
            sys.exit(1)
        rid = run_info["databaseId"]
        ad, run_date = download_run_to_dir(rid, args.models)
        artifacts_dirs.append(ad)
        temp_dirs.append(ad)

    # Merge all artifact sources into a combined staging directory.  Each
    # source may have its own jobs/ subdirectory tree — we link them all under
    # one root so prepare_submission sees every job folder.
    if len(artifacts_dirs) == 1:
        combined_dir = artifacts_dirs[0]
    else:
        combined_dir = Path(tempfile.mkdtemp(prefix="tbench-combined-"))
        temp_dirs.append(combined_dir)
        combined_jobs = combined_dir / "jobs"
        combined_jobs.mkdir(parents=True, exist_ok=True)
        for ad in artifacts_dirs:
            for jf in find_job_folders(ad):
                dest = combined_jobs / jf.name
                if dest.exists():
                    # Unlikely name collision — append a suffix
                    dest = combined_jobs / f"{jf.name}__dup{id(jf)}"
                # Symlink to avoid copying gigabytes of trial data
                dest.symlink_to(jf)

    # Prepare submission
    n_sources = len(artifacts_dirs)
    print(f"\nPreparing submission from {n_sources} source(s) in {args.output_dir}...")
    submissions = prepare_submission(combined_dir, args.output_dir, args.models)

    if not submissions:
        print("No valid submissions created")
        sys.exit(1)

    print(f"\n✅ Created {len(submissions)} submission(s):")
    for model, path in submissions.items():
        # Count job folders and total trials
        job_dirs = [d for d in path.iterdir() if d.is_dir() and d.name != "__pycache__"]
        total_trials = sum(
            1 for jd in job_dirs for t in jd.iterdir() if t.is_dir() and "__" in t.name
        )
        print(f"  - {model}: {len(job_dirs)} job(s), {total_trials} trial(s)")

    # Print next steps
    print("\nNext steps - submit with hf CLI:")
    print(f"  hf upload {LEADERBOARD_REPO} \\")
    print(f"    {args.output_dir}/submissions submissions \\")
    print("    --repo-type dataset --create-pr \\")
    print(f'    --commit-message "Mux submission ({run_date})"')

    # Clean up temp directories if we created any
    if temp_dirs:
        print(f"\nNote: Temp artifacts in {len(temp_dirs)} director(ies):")
        for td in temp_dirs:
            print(f"  {td}")
        print("      Delete with: rm -rf " + " ".join(str(td) for td in temp_dirs))


if __name__ == "__main__":
    main()
