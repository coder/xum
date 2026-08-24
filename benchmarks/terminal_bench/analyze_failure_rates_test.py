from benchmarks.terminal_bench.analyze_failure_rates import (
    OptimizationOpportunity,
    opportunity_json,
)


def test_json_output_preserves_legacy_keys() -> None:
    opportunity = OptimizationOpportunity(
        task_id="task-1",
        xum_fail_rate=0.75,
        avg_other_fail_rate=0.25,
        ratio=3.0,
        xum_agent="Xum__Test",
        n_other_agents=4,
    )

    payload = opportunity_json(opportunity)

    assert payload["xum_fail_rate"] == payload["mux_fail_rate"] == 0.75
    assert payload["xum_agent"] == payload["mux_agent"] == "Xum__Test"
