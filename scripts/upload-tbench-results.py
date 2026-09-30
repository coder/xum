#!/usr/bin/env python3
"""
Upload Terminal-Bench results to BigQuery.

Reads Harbor output from jobs/<timestamp>/ and uploads one row per trial
to the benchmarks.tbench_results table.

Usage:
    # Upload results from CI (uses GOOGLE_APPLICATION_CREDENTIALS)
    python scripts/upload-tbench-results.py

    # Dry run (print rows without uploading)
    python scripts/upload-tbench-results.py --dry-run

Environment variables (from GitHub Actions):
    GITHUB_RUN_ID, GITHUB_WORKFLOW, GITHUB_SHA, GITHUB_REF,
    GITHUB_ACTOR, GITHUB_EVENT_NAME
    GCP_PROJECT_ID (default: mux-benchmarks)
    BQ_DATASET (default: benchmarks)
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def find_job_folders() -> list[Path]:
    """Find all job folders in jobs/."""
    jobs_dir = Path("jobs")
    if not jobs_dir.exists():
        return []
    return [d for d in jobs_dir.iterdir() if d.is_dir()]


def load_json(path: Path) -> dict | None:
    """Load JSON file, return None on error."""
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def env_flag(name: str) -> bool:
    """Return True for the env boolean spellings emitted by workflows."""
    return (os.environ.get(name) or "").strip().lower() in {"1", "true"}


def extract_trial_score(trial_result: dict) -> float | None:
    """Extract score from trial result, supporting multiple Harbor formats."""
    score = trial_result.get("score")
    if isinstance(score, (int, float)):
        return float(score)

    verifier_result = trial_result.get("verifier_result") or {}
    rewards = verifier_result.get("rewards") or {}
    reward_score = rewards.get("reward")
    if isinstance(reward_score, (int, float)):
        return float(reward_score)

    return None


def extract_trial_passed(trial_result: dict, score: float | None) -> bool | None:
    """Extract pass/fail from trial result, falling back to score heuristics."""
    passed = trial_result.get("passed")
    if isinstance(passed, bool):
        return passed

    verifier_result = trial_result.get("verifier_result") or {}
    verifier_passed = verifier_result.get("passed")
    if isinstance(verifier_passed, bool):
        return verifier_passed

    if score is not None:
        return score > 0

    return None


def extract_token_counts_and_cost(
    trial_result: dict,
) -> tuple[int | None, int | None, float | None]:
    """Extract token usage and cost from trial result, supporting Harbor agent_result."""
    n_input_tokens = trial_result.get("n_input_tokens")
    n_output_tokens = trial_result.get("n_output_tokens")
    cost_usd = trial_result.get("cost_usd")

    agent_result = trial_result.get("agent_result") or {}
    if n_input_tokens is None:
        n_input_tokens = agent_result.get("n_input_tokens")
    if n_output_tokens is None:
        n_output_tokens = agent_result.get("n_output_tokens")
    # cost_usd is set by mux agent from CLI's run-complete event
    if cost_usd is None:
        cost_usd = agent_result.get("cost_usd")

    return n_input_tokens, n_output_tokens, cost_usd


def extract_task_timestamps(trial_result: dict) -> tuple[str | None, str | None]:
    """Extract agent execution timestamps from trial result.

    Harbor's trial runner records started_at/finished_at around agent execution.
    Prefer agent_execution timing (excludes env setup + verification),
    falling back to top-level trial timing if agent_execution is missing.

    Returns ISO 8601 timestamp strings suitable for BQ TIMESTAMP columns.
    Duration can be computed at query time: TIMESTAMP_DIFF(task_completed_at, task_started_at, SECOND).
    """
    agent_execution = trial_result.get("agent_execution") or {}
    started = agent_execution.get("started_at")
    finished = agent_execution.get("finished_at")

    # Fall back to top-level trial timing
    if not started or not finished:
        started = trial_result.get("started_at")
        finished = trial_result.get("finished_at")

    if not started or not finished:
        return None, None

    # Normalize RFC3339 'Z' suffix to '+00:00' for fromisoformat compatibility
    # (Python < 3.11 rejects trailing 'Z', common in JS/Harbor output)
    started = started.replace("Z", "+00:00") if isinstance(started, str) else started
    finished = finished.replace("Z", "+00:00") if isinstance(finished, str) else finished

    # Validate timestamps parse correctly before sending to BQ
    try:
        datetime.fromisoformat(started)
        datetime.fromisoformat(finished)
    except (ValueError, TypeError):
        return None, None

    return started, finished


def build_rows(job_folder: Path) -> list[dict]:
    """Build BigQuery rows for all trials in a job folder."""
    rows = []

    # Load job-level files
    job_config = load_json(job_folder / "config.json") or {}
    job_result = load_json(job_folder / "result.json") or {}

    run_id = job_folder.name

    # Extract top-level stats from Harbor result.json
    stats = job_result.get("stats", {})
    n_total_trials = job_result.get("n_total_trials") or stats.get("n_trials", 0)

    # Get mean score from evals (Harbor format)
    evals = stats.get("evals", {})
    mean_scores = []
    for eval_entry in evals.values():
        metrics = eval_entry.get("metrics", [])
        if metrics and "mean" in metrics[0]:
            mean_scores.append(metrics[0]["mean"])
    accuracy = sum(mean_scores) / len(mean_scores) if mean_scores else None

    # Count resolved/unresolved from trial results
    n_resolved = 0
    n_unresolved = 0

    # GitHub context from environment
    github_run_id = os.environ.get("GITHUB_RUN_ID")
    github_context = {
        "github_run_id": int(github_run_id) if github_run_id else None,
        "github_workflow": os.environ.get("GITHUB_WORKFLOW"),
        "github_sha": os.environ.get("GITHUB_SHA"),
        "github_ref": os.environ.get("GITHUB_REF"),
        "github_actor": os.environ.get("GITHUB_ACTOR"),
        "github_event_name": os.environ.get("GITHUB_EVENT_NAME"),
    }

    # Run configuration (job-level fallbacks)
    job_agents = job_config.get("agents", [{}])
    job_model_name = job_agents[0].get("model_name") if job_agents else None
    job_thinking_level = job_agents[0].get("kwargs", {}).get("thinking_level") if job_agents else None
    job_mode = job_agents[0].get("kwargs", {}).get("mode") if job_agents else None
    
    # Dataset from job config
    datasets = job_config.get("datasets", [{}])
    dataset_name = datasets[0].get("name") if datasets else None
    dataset_version = datasets[0].get("version") if datasets else None
    dataset = f"{dataset_name}@{dataset_version}" if dataset_name and dataset_version else None
    if dataset is None:
        dataset = job_config.get("dataset")

    experiments = os.environ.get("MUX_EXPERIMENTS")
    mux_run_as_goal = env_flag("MUX_RUN_AS_GOAL")

    # Raw JSON for future-proofing
    run_result_json = json.dumps(job_result) if job_result else None
    run_metadata_json = None  # Harbor doesn't have separate run_metadata.json

    # Iterate trial folders
    for trial_folder in job_folder.iterdir():
        if not trial_folder.is_dir():
            continue

        trial_result = load_json(trial_folder / "result.json")
        if not trial_result:
            continue

        # Load trial-level config for model_name etc.
        trial_config = load_json(trial_folder / "config.json") or {}
        trial_agent = trial_config.get("agent", {})
        
        # Prefer trial-level config, fall back to job-level
        model_name = trial_agent.get("model_name") or job_model_name
        thinking_level = trial_agent.get("kwargs", {}).get("thinking_level") or job_thinking_level
        mode = trial_agent.get("kwargs", {}).get("mode") or job_mode

        task_id = trial_folder.name

        # Per-trial fields (Harbor stores score under verifier_result.rewards.reward)
        score = extract_trial_score(trial_result)
        passed = extract_trial_passed(trial_result, score)

        # Track resolved/unresolved
        if passed is True:
            n_resolved += 1
        elif passed is False:
            n_unresolved += 1

        # Token usage and cost from agent result (cost computed by mux CLI)
        n_input_tokens, n_output_tokens, cost_usd = extract_token_counts_and_cost(
            trial_result
        )

        # Agent execution timestamps from Harbor's trial runner
        task_started_at, task_completed_at = extract_task_timestamps(trial_result)

        row = {
            "run_id": run_id,
            "task_id": task_id,
            **github_context,
            "model_name": model_name,
            "thinking_level": thinking_level,
            "mode": mode,
            "dataset": dataset,
            "experiments": experiments,
            "mux_run_as_goal": mux_run_as_goal,
            "run_started_at": None,  # Not available in Harbor format
            "run_completed_at": None,
            "n_resolved": None,  # Will be set after counting all trials
            "n_unresolved": None,
            "accuracy": accuracy,
            "passed": passed,
            "score": score,
            "n_input_tokens": n_input_tokens,
            "n_output_tokens": n_output_tokens,
            "cost_usd": cost_usd,
            "task_started_at": task_started_at,
            "task_completed_at": task_completed_at,
            "run_result_json": run_result_json,
            "run_metadata_json": run_metadata_json,
            "task_result_json": json.dumps(trial_result),
            "ingested_at": datetime.now(timezone.utc).isoformat(),
        }
        rows.append(row)

    # Update n_resolved/n_unresolved on all rows
    for row in rows:
        row["n_resolved"] = n_resolved
        row["n_unresolved"] = n_unresolved

    return rows


def _filter_rows_for_table_schema(
    client: "bigquery.Client", table_id: str, rows: list[dict]
) -> list[dict]:
    """Drop unknown keys to avoid insert_rows_json schema errors.

    This lets us safely add new fields to the upload script before
    the corresponding BQ column exists — unknown keys are silently dropped.
    """
    table = client.get_table(table_id)
    allowed = {field.name for field in table.schema}

    filtered: list[dict] = []
    for row in rows:
        filtered.append({k: v for k, v in row.items() if k in allowed})

    return filtered


def upload_to_bigquery(rows: list[dict], project_id: str, dataset: str) -> None:
    """Upload rows to BigQuery using the Python client."""
    from google.cloud import bigquery

    client = bigquery.Client(project=project_id)
    table_id = f"{project_id}.{dataset}.tbench_results"

    rows = _filter_rows_for_table_schema(client, table_id, rows)

    errors = client.insert_rows_json(table_id, rows)
    if errors:
        print(f"BigQuery insert errors: {errors}", file=sys.stderr)
        sys.exit(1)

    print(f"Uploaded {len(rows)} row(s) to {table_id}")


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Upload tbench results to BigQuery")
    parser.add_argument(
        "--dry-run", action="store_true", help="Print rows without uploading"
    )
    parser.add_argument(
        "--project-id",
        default=os.environ.get("GCP_PROJECT_ID", "mux-benchmarks"),
        help="GCP project ID",
    )
    parser.add_argument(
        "--dataset",
        default=os.environ.get("BQ_DATASET", "benchmarks"),
        help="BigQuery dataset",
    )
    args = parser.parse_args()

    job_folders = find_job_folders()
    if not job_folders:
        print("No job folders found in jobs/", file=sys.stderr)
        sys.exit(1)

    all_rows = []
    for job_folder in job_folders:
        rows = build_rows(job_folder)
        all_rows.extend(rows)
        print(f"Found {len(rows)} trial(s) in {job_folder.name}")

    if not all_rows:
        print("No trial results found", file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print(f"\n=== Dry run: {len(all_rows)} row(s) ===")
        for row in all_rows[:3]:  # Print first 3 rows
            print(json.dumps(row, indent=2, default=str))
        if len(all_rows) > 3:
            print(f"... and {len(all_rows) - 3} more row(s)")
        return

    upload_to_bigquery(all_rows, args.project_id, args.dataset)


if __name__ == "__main__":
    main()
