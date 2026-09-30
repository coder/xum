#!/usr/bin/env python3
"""Print a TLC `-dumpTrace json` counterexample as numbered steps with only the changed fields."""
import json
import sys


def flatten(prefix, value, out):
    if isinstance(value, dict):
        for key, inner in value.items():
            flatten(f"{prefix}.{key}" if prefix else key, inner, out)
    elif isinstance(value, list) and value and all(isinstance(v, (dict, list)) for v in value):
        for index, inner in enumerate(value, start=1):
            flatten(f"{prefix}[{index}]", inner, out)
    else:
        out[prefix] = json.dumps(value)


def main(path):
    trace = json.load(open(path))["counterexample"]
    states = trace["state"]
    actions = trace["action"]
    previous = {}
    flatten("", states[0][1], previous)
    print("0 Init")
    for step, action in enumerate(actions, start=1):
        # Each action is [[fromIndex, fromState], actionInfo, [toIndex, toState]].
        info = action[1]
        current = {}
        flatten("", action[2][1], current)
        changed = [f"{k}={v}" for k, v in current.items() if previous.get(k) != v]
        context = ",".join(f"{k}={v}" for k, v in info.get("context", {}).items())
        print(f"{step} {info['name']}({context}) line {info['location']['beginLine']}")
        for line in changed:
            print(f"    {line}")
        previous = current


if __name__ == "__main__":
    main(sys.argv[1])
