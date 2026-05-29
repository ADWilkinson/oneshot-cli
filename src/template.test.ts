import { describe, expect, test } from "bun:test";
import { fillTemplate } from "./template";

describe("fillTemplate", () => {
  test("inserts dollar sequences literally instead of as replacement patterns", () => {
    const value = "fix bash $'ANSI' quoting, PID $$, sed & ref $&, capture $1";
    const result = fillTemplate("Task: {{task}}\nEnd.", { task: value });
    expect(result).toBe(`Task: ${value}\nEnd.`);
  });

  test("replaces every occurrence of a placeholder, not just the first", () => {
    const result = fillTemplate(
      "checkout {{branch}}; push {{branch}}; ready {{branch}}",
      { branch: "oneshot/fix-123" },
    );
    expect(result).toBe(
      "checkout oneshot/fix-123; push oneshot/fix-123; ready oneshot/fix-123",
    );
  });

  test("fills multiple distinct placeholders", () => {
    const result = fillTemplate("{{a}} then {{b}} then {{a}}", { a: "x", b: "y" });
    expect(result).toBe("x then y then x");
  });

  test("leaves unknown placeholders untouched", () => {
    const result = fillTemplate("{{known}} {{unknown}}", { known: "ok" });
    expect(result).toBe("ok {{unknown}}");
  });
});
