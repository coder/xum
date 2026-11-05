import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { SkillIndicator } from "@/browser/components/SkillIndicator/SkillIndicator.js";

// Skills button from the chat header — one cell per story in SkillIndicator.stories.tsx.
// Every story's play() clicks the button to pin the skills popover open; the component has
// no `defaultOpen`, so the preview clicks the trigger once on mount. The popover is a Radix
// portal (overlay) → card mode "single". Pure props: no API data.

const SSH_TIMEOUT = "SSH connection to dev.example did not become healthy within 10000ms";

const DEFAULT_SKILLS = [
  { name: "my-company-style", description: "Company-wide coding style", scope: "global" as const },
  { name: "init", description: "Bootstrap an AGENTS.md file", scope: "built-in" as const },
];

const UNAVAILABLE_SOURCES = [
  {
    scope: "project" as const,
    displayPath: "/home/coder/project/.xum/skills",
    message: SSH_TIMEOUT,
  },
  {
    scope: "project" as const,
    displayPath: "/home/coder/project/.agents/skills",
    message: SSH_TIMEOUT,
  },
];

const DISPLAY_NAME_SKILLS = [
  {
    name: "poteto-mode",
    displayName: "Poteto Mode",
    description: "Route work through the pstack skills",
    scope: "global" as const,
  },
  { name: "init", description: "Bootstrap an AGENTS.md file", scope: "built-in" as const },
];

const DISPLAY_NAME_WARNINGS = [
  {
    directoryName: "poteto-mode",
    scope: "global" as const,
    displayPath: "/home/coder/.xum/skills/poteto-mode/SKILL.md",
    message:
      "SKILL.md name 'Poteto Mode' is not the directory name, so Xum loads the skill as 'poteto-mode'.",
    hint: "Invoke it as /poteto-mode. Set name: poteto-mode to remove this warning.",
  },
];

// Stand-in for the stories' play(): click the skills button to pin the popover open.
// `width` reproduces the phone stories' viewport (phone390).
function Frame(props: { width?: number; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const timer = setTimeout(
      () => ref.current?.querySelector<HTMLButtonElement>("button")?.click(),
      50
    );
    return () => clearTimeout(timer);
  }, []);
  return (
    <MuxPreviewShell>
      <div
        ref={ref}
        className="bg-background text-foreground flex min-h-[360px] items-start justify-end p-6"
        style={props.width ? { width: props.width } : undefined}
      >
        {props.children}
      </div>
    </MuxPreviewShell>
  );
}

export const UnavailableProjectSources = () => (
  <Frame>
    <SkillIndicator
      loadedSkills={[]}
      availableSkills={DEFAULT_SKILLS}
      unavailableSources={UNAVAILABLE_SOURCES}
    />
  </Frame>
);

export const UnavailableProjectSourcesPhone = () => (
  <Frame width={390}>
    <SkillIndicator
      loadedSkills={[]}
      availableSkills={DEFAULT_SKILLS}
      unavailableSources={UNAVAILABLE_SOURCES}
    />
  </Frame>
);

export const DisplayNameWarning = () => (
  <Frame>
    <SkillIndicator
      loadedSkills={[]}
      availableSkills={DISPLAY_NAME_SKILLS}
      skillWarnings={DISPLAY_NAME_WARNINGS}
      unavailableSources={[]}
    />
  </Frame>
);

export const DisplayNameWarningPhone = () => (
  <Frame width={390}>
    <SkillIndicator
      loadedSkills={[]}
      availableSkills={DISPLAY_NAME_SKILLS}
      skillWarnings={DISPLAY_NAME_WARNINGS}
      unavailableSources={[]}
    />
  </Frame>
);
