import { describe, expect, it } from "bun:test";
import { parseCommand } from "./parser";
import { getSlashCommandSuggestions } from "./suggestions";

describe("/side command", () => {
  it("opens an empty side chat without a question", () => {
    expect(parseCommand("/side")).toEqual({ type: "side" });
    expect(parseCommand("/side   ")).toEqual({ type: "side" });
  });

  it("rejects questions and flags instead of sending them or discarding the text", () => {
    for (const command of ["side", "btw"]) {
      for (const input of ["why is this\nslow?", "--help"]) {
        expect(parseCommand(`/${command} ${input}`)).toEqual({
          type: "command-invalid-args",
          command,
          input,
          usage: `/${command}`,
        });
      }
    }
  });

  it("accepts /btw as an alias without arguments", () => {
    expect(parseCommand("/btw")).toEqual({ type: "side" });
    expect(parseCommand("/btw   ")).toEqual({ type: "side" });
  });

  it("is not suggested while creating a workspace", () => {
    const keys = (variant: "workspace" | "creation") =>
      getSlashCommandSuggestions("/", { variant }).map((suggestion) => suggestion.display);
    expect(keys("workspace")).toContain("/side");
    expect(keys("workspace")).toContain("/btw");
    expect(keys("creation")).not.toContain("/side");
    expect(keys("creation")).not.toContain("/btw");
  });
});
