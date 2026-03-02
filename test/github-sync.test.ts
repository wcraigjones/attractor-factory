import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  effectiveReviewDecision,
  githubSyncConfigFromEnv,
  hasFeedbackText,
  isReviewRunStale,
  issueTargetBranch,
  parseIssueNumbers,
  pullReviewStatus,
  verifyGitHubWebhookSignature
} from "../apps/factory-api/src/github-sync.js";

describe("github sync helpers", () => {
  it("derives default sync config from env", () => {
    const config = githubSyncConfigFromEnv({
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "pem"
    });
    expect(config.enabled).toBe(true);
    expect(config.reconcileIntervalMinutes).toBe(15);
  });

  it("verifies webhook signature using sha256", () => {
    const raw = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    const secret = "secret";
    const digest = createHmac("sha256", secret).update(raw).digest("hex");
    expect(
      verifyGitHubWebhookSignature({
        rawBody: raw,
        signatureHeader: `sha256=${digest}`,
        secret
      })
    ).toBe(true);
    expect(
      verifyGitHubWebhookSignature({
        rawBody: raw,
        signatureHeader: "sha256=deadbeef",
        secret
      })
    ).toBe(false);
  });

  it("builds issue branch names and parses issue references", () => {
    expect(issueTargetBranch(42, "Add Retry-Safe Checkout Authorization Flow")).toBe(
      "attractor/issue-42-add-retry-safe-checkout-authorization-flow"
    );
    expect(parseIssueNumbers("Implements #12 and closes #34 (#12 duplicate)")).toEqual([12, 34]);
  });

  it("coerces review decision when feedback exists", () => {
    expect(hasFeedbackText({ summary: "needs work" })).toBe(true);
    expect(effectiveReviewDecision("APPROVE", true)).toBe("REQUEST_CHANGES");
    expect(effectiveReviewDecision("REJECT", true)).toBe("REJECT");
    expect(effectiveReviewDecision("APPROVE", false)).toBe("APPROVE");
  });

  it("marks reviews as stale when head sha changes", () => {
    expect(isReviewRunStale({ currentHeadSha: "abc123", reviewedHeadSha: "abc123" })).toBe(false);
    expect(isReviewRunStale({ currentHeadSha: "def456", reviewedHeadSha: "abc123" })).toBe(true);
    expect(isReviewRunStale({ currentHeadSha: "def456", reviewedHeadSha: null })).toBe(false);
  });

  it("derives pull review status with stale precedence", () => {
    expect(pullReviewStatus({ hasReview: true, stale: true, minutesRemaining: 120 })).toBe("Stale");
    expect(pullReviewStatus({ hasReview: true, stale: false, minutesRemaining: 120 })).toBe("Completed");
    expect(pullReviewStatus({ hasReview: false, stale: false, minutesRemaining: -1 })).toBe("Overdue");
    expect(pullReviewStatus({ hasReview: false, stale: false, minutesRemaining: 30 })).toBe("Pending");
  });
});
