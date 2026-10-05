import { z } from "zod";

export const ComputerUseUnsupportedReasonSchema = z.enum([
  "requires_desktop_app",
  "unsupported_platform",
  "no_display",
  "wayland_session",
  "input_driver_unavailable",
]);
export type ComputerUseUnsupportedReason = z.infer<typeof ComputerUseUnsupportedReasonSchema>;

export const ComputerUsePermissionsSchema = z.object({
  screenRecording: z.enum(["granted", "denied", "not-determined"]),
  accessibility: z.enum(["granted", "denied"]),
});
export type ComputerUsePermissions = z.infer<typeof ComputerUsePermissionsSchema>;

export const ComputerUsePermissionKindSchema = z.enum(["screenRecording", "accessibility"]);
export type ComputerUsePermissionKind = z.infer<typeof ComputerUsePermissionKindSchema>;

export const ComputerUseStatusSchema = z.object({
  supported: z.boolean(),
  unsupportedReason: ComputerUseUnsupportedReasonSchema.optional(),
  platform: z.string(),
  ownerWorkspaceId: z.string().nullable(),
  /** False while a workspace owns computer use but another app holds the stop shortcut. */
  stopShortcutRegistered: z.boolean(),
  /** Null where the OS has no privacy gate for screen capture or input (Linux). */
  permissions: ComputerUsePermissionsSchema.nullable(),
});
export type ComputerUseStatus = z.infer<typeof ComputerUseStatusSchema>;
