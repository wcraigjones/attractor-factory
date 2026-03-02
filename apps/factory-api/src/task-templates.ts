import { z } from "zod";

export const TASK_TEMPLATE_TRIGGER_EVENTS = [
  "GITHUB_ISSUE_OPENED",
  "GITHUB_ISSUE_REOPENED",
  "GITHUB_ISSUE_LABELED",
  "GITHUB_ISSUE_COMMENT_CREATED",
  "GITHUB_PR_OPENED",
  "GITHUB_PR_SYNCHRONIZE",
  "GITHUB_PR_MERGED",
  "GITHUB_PR_REVIEW_CHANGES_REQUESTED",
  "GITHUB_PR_REVIEW_COMMENT_CREATED"
] as const;

export const TASK_TEMPLATE_BRANCH_STRATEGIES = [
  "TEMPLATE_DEFAULT",
  "ISSUE_BRANCH",
  "PR_HEAD"
] as const;

export type TaskTemplateTriggerEvent = (typeof TASK_TEMPLATE_TRIGGER_EVENTS)[number];
export type TaskTemplateBranchStrategy = (typeof TASK_TEMPLATE_BRANCH_STRATEGIES)[number];

export interface TaskTemplateTriggerRule {
  id: string;
  enabled: boolean;
  event: TaskTemplateTriggerEvent;
  branchStrategy: TaskTemplateBranchStrategy;
  labelAny?: string[];
  commentContainsAny?: string[];
  baseBranchAny?: string[];
  headBranchAny?: string[];
}

export interface TriggerIssueContext {
  number: number;
  title: string;
  state: string;
  labels: string[];
  updatedAt: string;
}

export interface TriggerPullRequestContext {
  number: number;
  state: string;
  title: string;
  headRefName: string;
  headSha: string;
  baseRefName: string;
  mergedAt: string | null;
  updatedAt: string;
}

export interface TriggerCommentContext {
  id: number;
  body: string;
  authorLogin: string | null;
  authorType: string | null;
}

export interface TriggerReviewContext {
  id: number;
  body: string;
  state: string;
  authorLogin: string | null;
  authorType: string | null;
}

export interface TriggerReviewCommentContext {
  id: number;
  body: string;
  authorLogin: string | null;
  authorType: string | null;
}

export interface TaskTemplateTriggerContext {
  event: TaskTemplateTriggerEvent;
  action?: string;
  issue?: TriggerIssueContext;
  pullRequest?: TriggerPullRequestContext;
  comment?: TriggerCommentContext;
  review?: TriggerReviewContext;
  reviewComment?: TriggerReviewCommentContext;
  labeledName?: string;
}

export const taskTemplateTriggerRuleSchema = z.object({
  id: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  event: z.enum(TASK_TEMPLATE_TRIGGER_EVENTS),
  branchStrategy: z.enum(TASK_TEMPLATE_BRANCH_STRATEGIES),
  labelAny: z.array(z.string().trim().min(1)).optional(),
  commentContainsAny: z.array(z.string().trim().min(1)).optional(),
  baseBranchAny: z.array(z.string().trim().min(1)).optional(),
  headBranchAny: z.array(z.string().trim().min(1)).optional()
});

const taskTemplateTriggerRulesSchema = z.array(taskTemplateTriggerRuleSchema).max(100);

function normalizeStringArray(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

export function sanitizeTriggerRule(rule: TaskTemplateTriggerRule): TaskTemplateTriggerRule {
  return {
    ...rule,
    labelAny: normalizeStringArray(rule.labelAny),
    commentContainsAny: normalizeStringArray(rule.commentContainsAny),
    baseBranchAny: normalizeStringArray(rule.baseBranchAny),
    headBranchAny: normalizeStringArray(rule.headBranchAny)
  };
}

export function validateTriggerRuleCompatibility(rule: TaskTemplateTriggerRule): string[] {
  const errors: string[] = [];
  const issueEvents = new Set<TaskTemplateTriggerEvent>([
    "GITHUB_ISSUE_OPENED",
    "GITHUB_ISSUE_REOPENED",
    "GITHUB_ISSUE_LABELED",
    "GITHUB_ISSUE_COMMENT_CREATED"
  ]);
  const commentEvents = new Set<TaskTemplateTriggerEvent>([
    "GITHUB_ISSUE_COMMENT_CREATED",
    "GITHUB_PR_REVIEW_CHANGES_REQUESTED",
    "GITHUB_PR_REVIEW_COMMENT_CREATED"
  ]);
  const prEvents = new Set<TaskTemplateTriggerEvent>([
    "GITHUB_PR_OPENED",
    "GITHUB_PR_SYNCHRONIZE",
    "GITHUB_PR_MERGED",
    "GITHUB_PR_REVIEW_CHANGES_REQUESTED",
    "GITHUB_PR_REVIEW_COMMENT_CREATED"
  ]);

  if (rule.labelAny && !issueEvents.has(rule.event)) {
    errors.push(`rule ${rule.id}: labelAny is only valid for issue events`);
  }
  if (rule.commentContainsAny && !commentEvents.has(rule.event)) {
    errors.push(`rule ${rule.id}: commentContainsAny is only valid for comment/review events`);
  }
  if (rule.baseBranchAny && !prEvents.has(rule.event)) {
    errors.push(`rule ${rule.id}: baseBranchAny is only valid for pull request events`);
  }
  if (rule.headBranchAny && !prEvents.has(rule.event)) {
    errors.push(`rule ${rule.id}: headBranchAny is only valid for pull request events`);
  }
  if (rule.branchStrategy === "ISSUE_BRANCH" && !issueEvents.has(rule.event)) {
    errors.push(`rule ${rule.id}: ISSUE_BRANCH strategy is only valid for issue events`);
  }
  if (rule.branchStrategy === "PR_HEAD" && !prEvents.has(rule.event)) {
    errors.push(`rule ${rule.id}: PR_HEAD strategy is only valid for pull request events`);
  }

  return errors;
}

export function parseTaskTemplateTriggerRules(input: unknown): {
  rules: TaskTemplateTriggerRule[];
  errors: string[];
} {
  if (input === null || input === undefined) {
    return { rules: [], errors: [] };
  }
  const parsed = taskTemplateTriggerRulesSchema.safeParse(input);
  if (!parsed.success) {
    return {
      rules: [],
      errors: parsed.error.issues.map((issue) => issue.message)
    };
  }

  const rules = parsed.data.map((rule) => sanitizeTriggerRule(rule));
  const idSet = new Set<string>();
  const errors: string[] = [];
  for (const rule of rules) {
    if (idSet.has(rule.id)) {
      errors.push(`duplicate rule id: ${rule.id}`);
    }
    idSet.add(rule.id);
    errors.push(...validateTriggerRuleCompatibility(rule));
  }

  return { rules, errors };
}

function includesAny(haystack: string, needles: string[]): boolean {
  const text = haystack.toLowerCase();
  return needles.some((needle) => text.includes(needle.toLowerCase()));
}

function normalizeBranch(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function matchesTriggerRule(rule: TaskTemplateTriggerRule, context: TaskTemplateTriggerContext): boolean {
  if (!rule.enabled) {
    return false;
  }
  if (rule.event !== context.event) {
    return false;
  }

  if (rule.labelAny?.length) {
    const labels = context.issue?.labels ?? [];
    const normalizedLabels = new Set(labels.map((label) => label.toLowerCase()));
    const matches = rule.labelAny.some((label) => normalizedLabels.has(label.toLowerCase()));
    if (!matches) {
      return false;
    }
  }

  if (rule.commentContainsAny?.length) {
    const commentBody =
      context.comment?.body ?? context.review?.body ?? context.reviewComment?.body ?? "";
    if (!includesAny(commentBody, rule.commentContainsAny)) {
      return false;
    }
  }

  if (rule.baseBranchAny?.length) {
    const base = normalizeBranch(context.pullRequest?.baseRefName);
    if (!base) {
      return false;
    }
    const allowed = new Set(rule.baseBranchAny.map((branch) => normalizeBranch(branch)));
    if (!allowed.has(base)) {
      return false;
    }
  }

  if (rule.headBranchAny?.length) {
    const head = normalizeBranch(context.pullRequest?.headRefName);
    if (!head) {
      return false;
    }
    const allowed = new Set(rule.headBranchAny.map((branch) => normalizeBranch(branch)));
    if (!allowed.has(head)) {
      return false;
    }
  }

  return true;
}

export function isHumanActor(authorType: string | null | undefined, authorLogin: string | null | undefined): boolean {
  const normalizedType = (authorType ?? "").trim();
  const normalizedLogin = (authorLogin ?? "").trim().toLowerCase();
  if (normalizedType !== "User") {
    return false;
  }
  if (normalizedLogin.endsWith("[bot]")) {
    return false;
  }
  return true;
}

function stripForKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-");
}

export function canonicalDedupeKey(context: TaskTemplateTriggerContext): string {
  switch (context.event) {
    case "GITHUB_ISSUE_OPENED":
      return `issues:opened:${context.issue?.number ?? 0}:${context.issue?.updatedAt ?? "unknown"}`;
    case "GITHUB_ISSUE_REOPENED":
      return `issues:reopened:${context.issue?.number ?? 0}:${context.issue?.updatedAt ?? "unknown"}`;
    case "GITHUB_ISSUE_LABELED":
      return `issues:labeled:${context.issue?.number ?? 0}:${stripForKey(context.labeledName ?? "unknown")}:${
        context.issue?.updatedAt ?? "unknown"
      }`;
    case "GITHUB_ISSUE_COMMENT_CREATED":
      return `issue_comment:created:${context.comment?.id ?? 0}`;
    case "GITHUB_PR_OPENED":
      return `pull_request:opened:${context.pullRequest?.number ?? 0}:${context.pullRequest?.headSha ?? "unknown"}`;
    case "GITHUB_PR_SYNCHRONIZE":
      return `pull_request:synchronize:${context.pullRequest?.number ?? 0}:${context.pullRequest?.headSha ?? "unknown"}`;
    case "GITHUB_PR_MERGED":
      return `pull_request:merged:${context.pullRequest?.number ?? 0}:${
        context.pullRequest?.mergedAt ?? context.pullRequest?.headSha ?? "unknown"
      }`;
    case "GITHUB_PR_REVIEW_CHANGES_REQUESTED":
      return `pull_request_review:changes_requested:${context.review?.id ?? 0}`;
    case "GITHUB_PR_REVIEW_COMMENT_CREATED":
      return `pull_request_review_comment:created:${context.reviewComment?.id ?? 0}`;
    default:
      return `event:${context.event}`;
  }
}

interface ParsedCronField {
  any: boolean;
  values: Set<number>;
}

interface ParsedCron {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

function parseIntStrict(value: string): number | null {
  if (!/^-?\d+$/.test(value)) {
    return null;
  }
  return Number.parseInt(value, 10);
}

function parseCronField(input: string, min: number, max: number, allowSevenForDow = false): ParsedCronField {
  const value = input.trim();
  if (value === "*") {
    return { any: true, values: new Set<number>() };
  }

  const result = new Set<number>();
  const segments = value.split(",").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`invalid cron field: ${input}`);
  }

  for (const segment of segments) {
    const [rawBase, rawStep] = segment.split("/");
    const step = rawStep === undefined ? 1 : parseIntStrict(rawStep);
    if (step === null || step <= 0) {
      throw new Error(`invalid cron step: ${segment}`);
    }

    let start = min;
    let end = max;

    if (rawBase === "*") {
      // use min..max
    } else if (rawBase.includes("-")) {
      const [rawStart, rawEnd] = rawBase.split("-");
      const parsedStart = parseIntStrict(rawStart ?? "");
      const parsedEnd = parseIntStrict(rawEnd ?? "");
      if (parsedStart === null || parsedEnd === null) {
        throw new Error(`invalid cron range: ${segment}`);
      }
      start = parsedStart;
      end = parsedEnd;
    } else {
      const parsed = parseIntStrict(rawBase);
      if (parsed === null) {
        throw new Error(`invalid cron value: ${segment}`);
      }
      start = parsed;
      end = parsed;
    }

    for (let valueCursor = start; valueCursor <= end; valueCursor += step) {
      let normalized = valueCursor;
      if (allowSevenForDow && normalized === 7) {
        normalized = 0;
      }
      if (normalized < min || normalized > max) {
        throw new Error(`cron value ${valueCursor} out of range ${min}-${max}`);
      }
      result.add(normalized);
    }
  }

  return {
    any: false,
    values: result
  };
}

function parseCronExpression(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error("cron expression must have 5 fields: minute hour day month weekday");
  }

  return {
    minute: parseCronField(parts[0] ?? "", 0, 59),
    hour: parseCronField(parts[1] ?? "", 0, 23),
    dayOfMonth: parseCronField(parts[2] ?? "", 1, 31),
    month: parseCronField(parts[3] ?? "", 1, 12),
    dayOfWeek: parseCronField(parts[4] ?? "", 0, 6, true)
  };
}

function matchesField(field: ParsedCronField, value: number): boolean {
  if (field.any) {
    return true;
  }
  return field.values.has(value);
}

function weekdayNumber(label: string): number {
  switch (label.toLowerCase()) {
    case "sun":
      return 0;
    case "mon":
      return 1;
    case "tue":
      return 2;
    case "wed":
      return 3;
    case "thu":
      return 4;
    case "fri":
      return 5;
    case "sat":
      return 6;
    default:
      throw new Error(`unsupported weekday label: ${label}`);
  }
}

function zonedParts(date: Date, timeZone: string): {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "2-digit",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const byType = new Map<string, string>();
  for (const part of parts) {
    byType.set(part.type, part.value);
  }

  const minute = Number.parseInt(byType.get("minute") ?? "0", 10);
  const rawHour = Number.parseInt(byType.get("hour") ?? "0", 10);
  const day = Number.parseInt(byType.get("day") ?? "1", 10);
  const month = Number.parseInt(byType.get("month") ?? "1", 10);
  const weekday = weekdayNumber((byType.get("weekday") ?? "Sun").slice(0, 3));

  return {
    minute,
    hour: rawHour === 24 ? 0 : rawHour,
    day,
    month,
    weekday
  };
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function nextCronDate(input: {
  cron: string;
  timeZone: string;
  from: Date;
  maxLookaheadMinutes?: number;
}): Date {
  const parsed = parseCronExpression(input.cron);
  if (!isValidIanaTimeZone(input.timeZone)) {
    throw new Error(`invalid timezone: ${input.timeZone}`);
  }

  const maxLookaheadMinutes = input.maxLookaheadMinutes ?? 60 * 24 * 366;
  const start = new Date(input.from);
  start.setUTCSeconds(0, 0);

  let cursor = new Date(start.getTime() + 60_000);
  for (let index = 0; index < maxLookaheadMinutes; index += 1) {
    const parts = zonedParts(cursor, input.timeZone);

    if (!matchesField(parsed.minute, parts.minute)) {
      cursor = new Date(cursor.getTime() + 60_000);
      continue;
    }
    if (!matchesField(parsed.hour, parts.hour)) {
      cursor = new Date(cursor.getTime() + 60_000);
      continue;
    }
    if (!matchesField(parsed.month, parts.month)) {
      cursor = new Date(cursor.getTime() + 60_000);
      continue;
    }

    const domMatch = matchesField(parsed.dayOfMonth, parts.day);
    const dowMatch = matchesField(parsed.dayOfWeek, parts.weekday);

    const domAny = parsed.dayOfMonth.any;
    const dowAny = parsed.dayOfWeek.any;

    const dayMatched = domAny && dowAny
      ? true
      : domAny
        ? dowMatch
        : dowAny
          ? domMatch
          : domMatch || dowMatch;

    if (!dayMatched) {
      cursor = new Date(cursor.getTime() + 60_000);
      continue;
    }

    return cursor;
  }

  throw new Error(`unable to find next cron time within ${maxLookaheadMinutes} minutes`);
}
