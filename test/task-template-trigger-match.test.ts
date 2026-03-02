import { describe, expect, it } from "vitest";

import { matchesTriggerRule, type TaskTemplateTriggerRule } from "../apps/factory-api/src/task-templates.js";

describe("task template trigger matching", () => {
  it("matches issue label filters", () => {
    const rule: TaskTemplateTriggerRule = {
      id: "rule-1",
      enabled: true,
      event: "GITHUB_ISSUE_LABELED",
      branchStrategy: "ISSUE_BRANCH",
      labelAny: ["groomed"]
    };

    expect(
      matchesTriggerRule(rule, {
        event: "GITHUB_ISSUE_LABELED",
        issue: {
          number: 42,
          title: "Ship feature",
          state: "open",
          labels: ["triaged", "groomed"],
          updatedAt: "2026-03-01T00:00:00.000Z"
        },
        labeledName: "groomed"
      })
    ).toBe(true);
  });

  it("matches PR branch filters", () => {
    const rule: TaskTemplateTriggerRule = {
      id: "rule-2",
      enabled: true,
      event: "GITHUB_PR_OPENED",
      branchStrategy: "PR_HEAD",
      baseBranchAny: ["main"],
      headBranchAny: ["attractor/issue-42-work"]
    };

    expect(
      matchesTriggerRule(rule, {
        event: "GITHUB_PR_OPENED",
        pullRequest: {
          number: 10,
          state: "open",
          title: "Implement issue",
          headRefName: "attractor/issue-42-work",
          headSha: "abc123",
          baseRefName: "main",
          mergedAt: null,
          updatedAt: "2026-03-01T00:00:00.000Z"
        }
      })
    ).toBe(true);
  });

  it("matches keyword filters for comment events", () => {
    const rule: TaskTemplateTriggerRule = {
      id: "rule-3",
      enabled: true,
      event: "GITHUB_ISSUE_COMMENT_CREATED",
      branchStrategy: "ISSUE_BRANCH",
      commentContainsAny: ["please refine", "address feedback"]
    };

    expect(
      matchesTriggerRule(rule, {
        event: "GITHUB_ISSUE_COMMENT_CREATED",
        comment: {
          id: 1,
          body: "Please refine based on reviewer feedback",
          authorLogin: "alice",
          authorType: "User"
        }
      })
    ).toBe(true);
  });
});
