import { describe, expect, it } from "vitest";

import { canonicalDedupeKey } from "../apps/factory-api/src/task-templates.js";

describe("task template dedupe keys", () => {
  it("builds issue label dedupe keys", () => {
    const key = canonicalDedupeKey({
      event: "GITHUB_ISSUE_LABELED",
      issue: {
        number: 7,
        title: "Plan",
        state: "open",
        labels: ["groomed"],
        updatedAt: "2026-03-01T10:00:00.000Z"
      },
      labeledName: "groomed"
    });

    expect(key).toBe("issues:labeled:7:groomed:2026-03-01T10:00:00.000Z");
  });

  it("builds comment and review keys", () => {
    expect(
      canonicalDedupeKey({
        event: "GITHUB_ISSUE_COMMENT_CREATED",
        comment: {
          id: 100,
          body: "please update",
          authorLogin: "alice",
          authorType: "User"
        }
      })
    ).toBe("issue_comment:created:100");

    expect(
      canonicalDedupeKey({
        event: "GITHUB_PR_REVIEW_CHANGES_REQUESTED",
        review: {
          id: 200,
          body: "needs work",
          state: "changes_requested",
          authorLogin: "bob",
          authorType: "User"
        }
      })
    ).toBe("pull_request_review:changes_requested:200");
  });

  it("builds PR opened and merged keys", () => {
    expect(
      canonicalDedupeKey({
        event: "GITHUB_PR_OPENED",
        pullRequest: {
          number: 12,
          state: "open",
          title: "feat",
          headRefName: "feature",
          headSha: "deadbeef",
          baseRefName: "main",
          mergedAt: null,
          updatedAt: "2026-03-01T10:00:00.000Z"
        }
      })
    ).toBe("pull_request:opened:12:deadbeef");

    expect(
      canonicalDedupeKey({
        event: "GITHUB_PR_MERGED",
        pullRequest: {
          number: 12,
          state: "closed",
          title: "feat",
          headRefName: "feature",
          headSha: "deadbeef",
          baseRefName: "main",
          mergedAt: "2026-03-01T10:00:00.000Z",
          updatedAt: "2026-03-01T10:00:00.000Z"
        }
      })
    ).toBe("pull_request:merged:12:2026-03-01T10:00:00.000Z");
  });
});
