// Bug bash of the agent resource limits (charter limits-keyboard): with an invalid value in the
// Memory limit field, Try again hid the field's error while the field still held the value, and
// with both fields invalid only the first one was named. Xum cannot manage its cgroup in the
// repro environments (the sandbox runs it in the root cgroup, CI as a non-delegated user), so a
// saved limit shows "Not applied" with Try again and changes no cgroup.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials } from "./helpers";

const CPU_ERROR = "CPU limit must be from 0.1 to 1024 cores, or empty for no limit.";
const MEMORY_ERROR = "Memory limit must be from 0.25 to 16384 GiB, or empty for no limit.";

test(
  "Try again keeps naming each resource limit field that holds an invalid value",
  { tags: ["bugbash", "RL1"] },
  async ({ app, screen, browser }) => {
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
    const retry = settings.getByRole("button", "Try again");
    // The tests of one target share the app, so another repro can have turned the switch on.
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    if (!(await toggle.isChecked())) await toggle.tap();
    await expect(cpu).toBeEnabled({ timeout: 15_000 });
    await cpu.fill("2");
    await browser.keyboard.press("Tab");
    await expect(retry).toBeVisible({ timeout: 15_000 });

    await cpu.fill("0.05");
    await memory.fill("-3");
    await browser.keyboard.press("Tab");
    await expect(settings.getByText(CPU_ERROR)).toBeVisible();
    await expect(settings.getByText(MEMORY_ERROR)).toBeVisible();

    await retry.tap();
    // Nothing on screen changes when the retry's reply arrives. The server applies limit changes
    // in order, so once the switch shows the reply to turning it off and on, the retry's reply
    // has arrived too.
    await toggle.tap();
    await expect(toggle).not.toBeChecked({ timeout: 15_000 });
    await toggle.tap();
    await expect(toggle).toBeChecked({ timeout: 15_000 });
    await expect(retry).toBeVisible({ timeout: 15_000 });

    await expect(memory).toHaveValue("-3");
    await expect(settings.getByText(CPU_ERROR)).toBeVisible();
    await expect(settings.getByText(MEMORY_ERROR)).toBeVisible();
  }
);
