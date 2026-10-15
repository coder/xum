import type { PluginSlashCommandDescriptor } from "@/common/orpc/schemas/agentPlugins";

import { isPluginSlashCommandConsented } from "./componentConsent";
import type { AgentPluginInfo } from "./discovery";

/**
 * Collect manifest-contributed slash commands from discovered plugins.
 *
 * Plugins arrive in container precedence order (project before global), so the
 * first declaration of a command name wins across plugins — the same
 * first-wins rule the other plugin artifact loaders use. A managed plugin's command is offered
 * only while it matches its review (#6629): an unreviewed one is skipped, so a lower plugin's
 * command of that name can win, as for the other component kinds.
 */
export function collectPluginSlashCommands(
  plugins: AgentPluginInfo[]
): PluginSlashCommandDescriptor[] {
  const byName = new Map<string, PluginSlashCommandDescriptor>();

  for (const plugin of plugins) {
    for (const command of plugin.manifest.contributes?.slashCommands ?? []) {
      if (
        byName.has(command.name) ||
        !isPluginSlashCommandConsented(plugin.componentConsent, command)
      ) {
        continue;
      }
      byName.set(command.name, {
        name: command.name,
        expansion: command.expansion,
        pluginName: plugin.name,
        scope: plugin.scope,
        ...(command.description !== undefined ? { description: command.description } : {}),
      });
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}
