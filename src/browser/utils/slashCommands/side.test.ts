import { describe, expect, it } from "bun:test";
import { parseCommand } from "./parser";
import { getSlashCommandSuggestions } from "./suggestions";

describe("/side command", () => {
  it("opens an empty side chat without a question", () => {
    expect(parseCommand("/side")).toEqual({ type: "side" });
    expect(parseCommand("/side   ")).toEqual({ type: "side" });
  });

  it("treats everything after /side as the question, newlines included", () => {
    expect(parseCommand("/side why is this\nslow?")).toEqual({
      type: "side",
      question: "why is this\nslow?",
    });
  });

  it("accepts /btw as an alias", () => {
    expect(parseCommand("/btw what does foo do?")).toEqual(parseCommand("/side what does foo do?"));
    expect(parseCommand("/btw")).toEqual({ type: "side" });
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
