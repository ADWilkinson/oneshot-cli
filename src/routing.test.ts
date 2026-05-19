import { describe, expect, test } from "bun:test";
import { normalizeConfig } from "./config";
import { getRoutedPhaseAgent, routeTask } from "./routing";

describe("routeTask", () => {
  test("keeps code and ship work on Codex frontier with xhigh effort", () => {
    const route = routeTask("fix the deposit timeout bug, verify it, and ship", {
      defaultProvider: "codex",
      routingEnabled: true,
    });

    expect(route.provider).toBe("codex");
    expect(route.reasoningEffort).toBe("xhigh");
    expect(route.mode).toBe("deep");
    expect(route.executionStyle).toBe("edit-verify-ship");
    expect(route.verification).toBe("deploy-health");
  });

  test("routes tool-heavy operations to Claude when adaptive routing is enabled", () => {
    const route = routeTask("check systemd logs on andrew-dev and restart the service", {
      defaultProvider: "codex",
      routingEnabled: true,
    });

    expect(route.provider).toBe("claude");
    expect(route.executionStyle).toBe("tool-ops");
    expect(route.reasoningEffort).toBe("xhigh");
  });

  test("uses the configured provider when adaptive routing is disabled", () => {
    const route = routeTask("check systemd logs on andrew-dev", {
      defaultProvider: "codex",
      routingEnabled: false,
    });

    expect(route.provider).toBe("codex");
    expect(route.enabled).toBe(false);
  });
});

describe("getRoutedPhaseAgent", () => {
  test("uses provider frontier models and adapts effort when routing is enabled", () => {
    const config = normalizeConfig(
      {
        host: "example-host",
        provider: "codex",
        claude: { model: "opus", timeoutMinutes: 180 },
        codex: {
          model: "gpt-frontier",
          reasoningEffort: "high",
          reviewModel: "gpt-review-frontier",
          reviewReasoningEffort: "xhigh",
          timeoutMinutes: 180,
        },
        routing: { enabled: true },
      },
      { requireHost: true },
    );
    const route = routeTask("check logs and restart the service", {
      defaultProvider: config.provider,
      routingEnabled: true,
    });

    expect(getRoutedPhaseAgent(config, "execute", route)).toEqual({
      provider: "claude",
      model: "opus",
      reasoningEffort: "xhigh",
    });

    const codexRoute = routeTask("fix failing ci", {
      defaultProvider: config.provider,
      routingEnabled: true,
    });
    expect(getRoutedPhaseAgent(config, "review", codexRoute)).toEqual({
      provider: "codex",
      model: "gpt-review-frontier",
      reasoningEffort: "xhigh",
    });
  });
});
