import type {
  RightSidebarLayoutPresetNode,
  RightSidebarPresetTabType,
} from "@/common/types/uiLayouts";
import { z } from "zod";

export const KeybindSchema = z
  // Keep in sync with the Keybind type (including allowShift). Strict schemas will
  // otherwise reject normalized config objects that include optional fields.
  .object({
    key: z.string().min(1),
    code: z.string().min(1).optional(),
    allowShift: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    shift: z.boolean().optional(),
    alt: z.boolean().optional(),
    meta: z.boolean().optional(),
    macCtrlBehavior: z.enum(["either", "command", "control"]).optional(),
  })
  .strict();

const RightSidebarPresetBaseTabSchema = z.enum(["costs", "review", "stats"]);

export const RightSidebarPresetTabSchema: z.ZodType<RightSidebarPresetTabType> = z.union([
  RightSidebarPresetBaseTabSchema,
  z
    .string()
    .min("terminal_new:".length + 1)
    .regex(/^terminal_new:.+$/),
]) as z.ZodType<RightSidebarPresetTabType>;

export const RightSidebarLayoutPresetNodeSchema: z.ZodType<RightSidebarLayoutPresetNode> = z.lazy(
  () => {
    const tabset = z
      .object({
        type: z.literal("tabset"),
        id: z.string().min(1),
        tabs: z.array(RightSidebarPresetTabSchema),
        activeTab: RightSidebarPresetTabSchema,
      })
      .strict();

    const split = z
      .object({
        type: z.literal("split"),
        id: z.string().min(1),
        direction: z.enum(["horizontal", "vertical"]),
        sizes: z.tuple([z.number(), z.number()]),
        children: z.tuple([RightSidebarLayoutPresetNodeSchema, RightSidebarLayoutPresetNodeSchema]),
      })
      .strict();

    return z.union([split, tabset]);
  }
);

export const RightSidebarLayoutPresetStateSchema = z
  .object({
    version: z.literal(1),
    nextId: z.number().int(),
    focusedTabsetId: z.string().min(1),
    root: RightSidebarLayoutPresetNodeSchema,
  })
  .strict();

export const RightSidebarWidthPresetSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("px"),
      value: z.number().int(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("fraction"),
      value: z.number(),
    })
    .strict(),
]);

export const LayoutPresetSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    leftSidebarCollapsed: z.boolean(),
    leftSidebarWidthPx: z.number().int().optional(),
    rightSidebar: z
      .object({
        collapsed: z.boolean(),
        width: RightSidebarWidthPresetSchema,
        layout: RightSidebarLayoutPresetStateSchema,
      })
      .strict(),
  })
  .strict();

export const LayoutSlotSchema = z
  .object({
    slot: z.number().int().min(1),
    preset: LayoutPresetSchema.optional(),
    keybindOverride: KeybindSchema.optional(),
  })
  .strict();

export const LayoutPresetsConfigSchema = z
  .object({
    version: z.literal(2),
    slots: z.array(LayoutSlotSchema),
  })
  .strict();
