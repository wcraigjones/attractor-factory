import { createHmac, timingSafeEqual } from "node:crypto";

import type { ReviewDecision } from "@prisma/client";

export const DEFAULT_SYNC_INTERVAL_MINUTES = 15;

export interface GitHubSyncConfig {
  enabled: boolean;
  webhookSecret: string | null;
  reconcileIntervalMinutes: number;
}

export function githubSyncConfigFromEnv(env: NodeJS.ProcessEnv): GitHubSyncConfig {
  const appConfigured = Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
  const explicit = env.GITHUB_SYNC_ENABLED?.trim().toLowerCase();
  const enabled =
    explicit === "true" ? true : explicit === "false" ? false : appConfigured;
  const parsedInterval = Number.parseInt(env.GITHUB_RECONCILE_INTERVAL_MINUTES ?? "", 10);
  const reconcileIntervalMinutes =
    Number.isFinite(parsedInterval) && parsedInterval > 0
      ? parsedInterval
      : DEFAULT_SYNC_INTERVAL_MINUTES;
  return {
    enabled,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET?.trim() || null,
    reconcileIntervalMinutes
  };
}

export function verifyGitHubWebhookSignature(input: {
  rawBody: Buffer;
  signatureHeader: string | null | undefined;
  secret: string | null;
}): boolean {
  if (!input.secret) {
    return false;
  }
  const signatureHeader = input.signatureHeader?.trim() ?? "";
  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const receivedHex = signatureHeader.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(receivedHex)) {
    return false;
  }

  const digestHex = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  const received = Buffer.from(receivedHex, "hex");
  const computed = Buffer.from(digestHex, "hex");
  if (received.length !== computed.length) {
    return false;
  }
  return timingSafeEqual(received, computed);
}

export function issueTargetBranch(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const safeSlug = slug.length > 0 ? slug : "work";
  return `attractor/issue-${issueNumber}-${safeSlug}`;
}

export function hasFeedbackText(input: {
  summary?: string | null;
  criticalFindings?: string | null;
  artifactFindings?: string | null;
}): boolean {
  const summary = (input.summary ?? "").trim();
  const critical = (input.criticalFindings ?? "").trim();
  const artifact = (input.artifactFindings ?? "").trim();
  return summary.length > 0 || critical.length > 0 || artifact.length > 0;
}

export function effectiveReviewDecision(
  requestedDecision: ReviewDecision,
  feedbackPresent: boolean
): ReviewDecision {
  if (!feedbackPresent) {
    return requestedDecision;
  }
  if (requestedDecision === "REJECT") {
    return "REJECT";
  }
  return "REQUEST_CHANGES";
}

export function checkConclusionForDecision(
  decision: ReviewDecision
): "success" | "neutral" | "failure" {
  if (decision === "APPROVE") {
    return "success";
  }
  if (decision === "EXCEPTION") {
    return "neutral";
  }
  return "failure";
}

export function parseIssueNumbers(text: string | null | undefined): number[] {
  if (!text) {
    return [];
  }
  const matches = [...text.matchAll(/#(\d{1,10})\b/g)];
  const unique = new Set<number>();
  for (const match of matches) {
    const value = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(value) && value > 0) {
      unique.add(value);
    }
  }
  return [...unique];
}

export function reviewSummaryMarkdown(input: {
  runId: string;
  reviewer: string;
  decision: ReviewDecision;
  summary?: string | null;
  criticalFindings?: string | null;
  artifactFindings?: string | null;
  reviewedAtIso: string;
}): string {
  const sections = [
    `## Attractor Review Summary`,
    ``,
    `- Run: \`${input.runId}\``,
    `- Reviewer: ${input.reviewer}`,
    `- Decision: **${input.decision}**`,
    `- Reviewed at: ${input.reviewedAtIso}`,
    ``,
    `### Context Summary`,
    input.summary?.trim() || "_No summary provided._",
    ``,
    `### Critical Findings`,
    input.criticalFindings?.trim() || "_No critical findings provided._",
    ``,
    `### Artifact Findings`,
    input.artifactFindings?.trim() || "_No artifact findings provided._"
  ];
  return sections.join("\n");
}

export type PrRiskLevel = "low" | "medium" | "high";

export type PullReviewStatus = "Pending" | "Completed" | "Overdue" | "Stale";

export function isReviewRunStale(input: {
  currentHeadSha: string;
  reviewedHeadSha?: string | null;
}): boolean {
  const reviewedHeadSha = (input.reviewedHeadSha ?? "").trim();
  if (reviewedHeadSha.length === 0) {
    return false;
  }
  return reviewedHeadSha !== input.currentHeadSha;
}

export function pullReviewStatus(input: {
  hasReview: boolean;
  stale: boolean;
  minutesRemaining: number;
}): PullReviewStatus {
  if (input.stale) {
    return "Stale";
  }
  if (input.hasReview) {
    return "Completed";
  }
  if (input.minutesRemaining < 0) {
    return "Overdue";
  }
  return "Pending";
}

export function inferPrRiskLevel(input: {
  title: string;
  body?: string | null;
  headRefName?: string | null;
}): PrRiskLevel {
  const haystack = `${input.title}\n${input.body ?? ""}\n${input.headRefName ?? ""}`.toLowerCase();
  if (/(auth|oauth|jwt|token|permission|rbac|security|secret|migration|schema|database|payment|billing)/.test(haystack)) {
    return "high";
  }
  if (/(api|handler|router|contract|infra|k8s|helm|deploy|worker|queue)/.test(haystack)) {
    return "medium";
  }
  return "low";
}
