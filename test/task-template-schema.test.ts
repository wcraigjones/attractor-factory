import { describe, expect, it } from "vitest";

import {
  isValidIanaTimeZone,
  nextCronDate,
  parseTaskTemplateTriggerRules
} from "../apps/factory-api/src/task-templates.js";

describe("task template schema helpers", () => {
  it("parses valid trigger rules", () => {
    const parsed = parseTaskTemplateTriggerRules([
      {
        id: "r1",
        enabled: true,
        event: "GITHUB_ISSUE_LABELED",
        branchStrategy: "ISSUE_BRANCH",
        labelAny: ["groomed"]
      }
    ]);

    expect(parsed.errors).toEqual([]);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0]?.id).toBe("r1");
  });

  it("rejects incompatible trigger rule combinations", () => {
    const parsed = parseTaskTemplateTriggerRules([
      {
        id: "bad",
        enabled: true,
        event: "GITHUB_PR_OPENED",
        branchStrategy: "ISSUE_BRANCH"
      }
    ]);

    expect(parsed.errors[0]).toContain("ISSUE_BRANCH strategy");
  });

  it("validates timezone and computes next cron occurrence", () => {
    expect(isValidIanaTimeZone("UTC")).toBe(true);
    expect(isValidIanaTimeZone("America/Chicago")).toBe(true);
    expect(isValidIanaTimeZone("not/a-timezone")).toBe(false);

    const next = nextCronDate({
      cron: "*/15 * * * *",
      timeZone: "UTC",
      from: new Date("2026-03-01T12:07:00.000Z")
    });

    expect(next.toISOString()).toBe("2026-03-01T12:15:00.000Z");
  });
});
