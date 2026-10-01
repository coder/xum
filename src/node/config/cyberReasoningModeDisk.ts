/**
 * Downgrade-safe config.json form of the "cyber" OpenAI reasoning mode.
 *
 * Builds before Cyber validate persisted reasoning modes as standard|pro, so one
 * "cyber" value makes them reject the whole project list. On disk Cyber is an
 * absent mode plus a boolean marker those builds strip as an unknown key. An
 * explicit mode an older build wrote wins over a stale marker.
 */

interface ReasoningModeSlot {
  owner: Record<string, unknown>;
  modeKey: string;
  markerKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectReasoningModeSlots(doc: Record<string, unknown>): ReasoningModeSlot[] {
  const slots: ReasoningModeSlot[] = [
    { owner: doc, modeKey: "advisorReasoningMode", markerKey: "advisorCyberReasoningMode" },
  ];
  const addSettings = (value: unknown) => {
    if (isRecord(value)) {
      slots.push({ owner: value, modeKey: "reasoningMode", markerKey: "cyberReasoningMode" });
    }
  };
  const eachValue = (value: unknown, visit: (entry: unknown) => void) => {
    if (isRecord(value)) Object.values(value).forEach(visit);
  };

  eachValue(doc.agentAiDefaults, (entry) => {
    addSettings(entry);
    if (isRecord(entry)) addSettings(entry.subagent);
  });
  eachValue(doc.subagentAiDefaults, addSettings);
  if (Array.isArray(doc.projects)) {
    for (const pair of doc.projects) {
      const project: unknown = Array.isArray(pair) ? pair[1] : undefined;
      if (!isRecord(project) || !Array.isArray(project.workspaces)) continue;
      for (const workspace of project.workspaces) {
        if (!isRecord(workspace)) continue;
        addSettings(workspace.aiSettings);
        eachValue(workspace.aiSettingsByAgent, addSettings);
        addSettings(workspace.taskAiPins);
      }
    }
  }
  return slots;
}

/** Rewrites Cyber modes into their disk form in place; pass a copy of runtime state. */
export function encodeCyberReasoningModesForDisk(doc: Record<string, unknown>): void {
  for (const slot of collectReasoningModeSlots(doc)) {
    if (slot.owner[slot.modeKey] === "cyber") {
      delete slot.owner[slot.modeKey];
      slot.owner[slot.markerKey] = true;
    }
  }
}

/** Restores Cyber modes from their disk form in place, before any normalization. */
export function decodeCyberReasoningModesFromDisk(doc: Record<string, unknown>): void {
  for (const slot of collectReasoningModeSlots(doc)) {
    if (slot.owner[slot.markerKey] === true && slot.owner[slot.modeKey] == null) {
      slot.owner[slot.modeKey] = "cyber";
    }
    delete slot.owner[slot.markerKey];
  }
}
