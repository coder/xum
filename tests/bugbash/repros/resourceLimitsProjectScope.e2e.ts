// Bug bash of the per-project agent resource limits (charter limits-fuzz): after an invalid value
// in a field, switching the Project picker reset the field to the new project's saved limit but
// kept the old field's error on screen.
// Settings → Agents → Resource limits has a Project picker: "All projects" edits the shared
// limit, a project edits its own limit. Xum cannot manage its cgroup in the repro environments,
// so a saved limit shows "Not applied" and changes no cgroup; only the saved values matter here.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials } from "./helpers";

const CPU_ERROR = "CPU limit must be from 0.1 to 1024 cores, or empty for no limit.";
const MEMORY_ERROR = "Memory limit must be from 0.25 to 16384 GiB, or empty for no limit.";

async function openResourceLimits(
  app: Parameters<Parameters<typeof test>[2]>[0]["app"],
  screen: Parameters<Parameters<typeof test>[2]>[0]["screen"],
  browser: Parameters<Parameters<typeof test>[2]>[0]["browser"]
) {
  await browser.setViewport({ width: 1440, height: 900 });
  await disableTutorials(app);
  await app.open();
  await browser.locator('[data-testid="settings-button"]').tap();
  const settings = screen.getByRole("dialog", "Settings");
  await expect(settings).toBeVisible({ timeout: 15_000 });
  await settings.getByRole("button", "Agents").tap();
  const toggle = settings.getByRole("switch", "Resource limits");
  const cpu = settings.getByRole("spinbutton", "CPU limit");
  const memory = settings.getByRole("spinbutton", "Memory limit");
  const picker = settings.getByRole("combobox", "Resource limits project");
  // The tests of one target share the app, so the switch can already be on.
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if (!(await toggle.isChecked())) await toggle.tap();
  await expect(cpu).toBeEnabled({ timeout: 15_000 });
  const pick = async (name: string) => {
    await picker.tap();
    await screen.getByRole("option", name).tap();
    await expect(picker).toHaveText(name);
  };
  return { settings, toggle, cpu, memory, pick };
}

test(
  "switching the project drops the field errors of the old project",
  { tags: ["bugbash", "RLP1"] },
  async ({ app, screen, browser }) => {
    const { settings, cpu, memory, pick } = await openResourceLimits(app, screen, browser);
    await pick("demo-app");
    await memory.fill("0");
    await browser.keyboard.press("Tab");
    await expect(settings.getByText(MEMORY_ERROR)).toBeVisible();

    // The field now shows the saved limit of all projects, which is valid.
    await pick("All projects");
    await expect(memory).not.toHaveValue("0");
    await expect(settings.getByText(MEMORY_ERROR)).not.toBeVisible();

    await cpu.fill("-1");
    await browser.keyboard.press("Tab");
    await expect(settings.getByText(CPU_ERROR)).toBeVisible();
    await pick("demo-app");
    await expect(settings.getByText(CPU_ERROR)).not.toBeVisible();
  }
);
