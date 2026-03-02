export type RunType = "planning" | "implementation" | "task";
export type TaskTemplateEnvironmentMode = "PROJECT_DEFAULT" | "NAMED";
export type TaskTemplateLaunchMode = "MANUAL" | "SCHEDULE" | "EVENT" | "REPLAY";
export type TaskTemplateTriggerEvent =
  | "GITHUB_ISSUE_OPENED"
  | "GITHUB_ISSUE_REOPENED"
  | "GITHUB_ISSUE_LABELED"
  | "GITHUB_ISSUE_COMMENT_CREATED"
  | "GITHUB_PR_OPENED"
  | "GITHUB_PR_SYNCHRONIZE"
  | "GITHUB_PR_MERGED"
  | "GITHUB_PR_REVIEW_CHANGES_REQUESTED"
  | "GITHUB_PR_REVIEW_COMMENT_CREATED";
export type TaskTemplateBranchStrategy = "TEMPLATE_DEFAULT" | "ISSUE_BRANCH" | "PR_HEAD";

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

export type RunStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED"
  | "TIMEOUT";

export interface RunModelConfig {
  provider: string;
  modelId: string;
  reasoningLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
  temperature?: number;
  maxTokens?: number;
}

export type EnvironmentKind = "KUBERNETES_JOB";

export interface EnvironmentResources {
  requests?: {
    cpu?: string;
    memory?: string;
  };
  limits?: {
    cpu?: string;
    memory?: string;
  };
}

export interface Environment {
  id: string;
  name: string;
  kind: EnvironmentKind;
  runnerImage: string;
  setupScript: string | null;
  serviceAccountName: string | null;
  resourcesJson: EnvironmentResources | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  namespace: string;
  githubInstallationId: string | null;
  repoFullName: string | null;
  defaultBranch: string | null;
  defaultEnvironmentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSecret {
  id: string;
  projectId: string;
  name: string;
  provider: string;
  k8sSecretName: string;
  keyMappings: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface AttractorDef {
  id: string;
  projectId: string;
  name: string;
  repoPath: string | null;
  contentPath: string | null;
  contentVersion: number;
  defaultRunType: RunType;
  modelConfig: RunModelConfig | null;
  description: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  projectId: string;
  attractorDefId: string;
  taskTemplateId: string | null;
  taskTemplateLaunchMode: TaskTemplateLaunchMode | null;
  attractorContentPath: string | null;
  attractorContentVersion: number | null;
  attractorContentSha256: string | null;
  githubIssueId: string | null;
  githubPullRequestId: string | null;
  environmentId: string | null;
  runType: RunType;
  sourceBranch: string;
  targetBranch: string;
  status: RunStatus;
  specBundleId: string | null;
  environmentSnapshot: RunExecutionEnvironment | null;
  prUrl: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface GitHubIssue {
  id: string;
  projectId: string;
  issueNumber: number;
  state: string;
  title: string;
  body: string | null;
  author: string | null;
  labelsJson: unknown | null;
  assigneesJson: unknown | null;
  url: string;
  openedAt: string;
  closedAt: string | null;
  updatedAt: string;
  syncedAt: string;
  createdAt: string;
}

export interface GitHubPullRequest {
  id: string;
  projectId: string;
  prNumber: number;
  state: string;
  title: string;
  body: string | null;
  url: string;
  headRefName: string;
  headSha: string;
  baseRefName: string;
  mergedAt: string | null;
  openedAt: string;
  closedAt: string | null;
  updatedAt: string;
  syncedAt: string;
  linkedIssueId: string | null;
}

export interface GitHubSyncState {
  projectId: string;
  issuesCursor: string | null;
  pullsCursor: string | null;
  lastIssueSyncAt: string | null;
  lastPullSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GlobalTaskTemplate {
  id: string;
  name: string;
  attractorName: string;
  runType: RunType;
  sourceBranch: string | null;
  targetBranch: string | null;
  environmentMode: TaskTemplateEnvironmentMode;
  environmentName: string | null;
  scheduleEnabled: boolean;
  scheduleCron: string | null;
  scheduleTimezone: string | null;
  triggersJson: TaskTemplateTriggerRule[] | null;
  description: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTemplate {
  id: string;
  projectId: string;
  scope: "PROJECT" | "GLOBAL";
  name: string;
  attractorName: string;
  runType: RunType;
  sourceBranch: string | null;
  targetBranch: string | null;
  environmentMode: TaskTemplateEnvironmentMode;
  environmentName: string | null;
  scheduleEnabled: boolean;
  scheduleCron: string | null;
  scheduleTimezone: string | null;
  scheduleNextRunAt: string | null;
  scheduleLastRunAt: string | null;
  scheduleLastError: string | null;
  triggersJson: TaskTemplateTriggerRule[] | null;
  description: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTemplateEventLedgerRecord {
  id: string;
  projectId: string;
  taskTemplateId: string;
  runId: string | null;
  eventName: string;
  eventAction: string | null;
  dedupeKey: string;
  deliveryId: string | null;
  entityType: string | null;
  entityNumber: number | null;
  matchedRuleIds: string[] | null;
  payload: unknown;
  status: string;
  reason: string | null;
  replayedAt: string | null;
  createdAt: string;
}

export type RunQuestionStatus = "PENDING" | "ANSWERED" | "TIMEOUT";

export interface RunQuestion {
  id: string;
  runId: string;
  nodeId: string;
  prompt: string;
  options: unknown | null;
  answer: unknown | null;
  status: RunQuestionStatus;
  createdAt: string;
  answeredAt: string | null;
}

export interface SpecBundle {
  id: string;
  runId: string;
  schemaVersion: string;
  manifestPath: string;
  createdAt: string;
}

export interface Artifact {
  id: string;
  runId: string;
  key: string;
  path: string;
  createdAt: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  ts: string;
  type: string;
  payload: unknown;
}

export interface RunExecutionEnvironment {
  id: string;
  name: string;
  kind: EnvironmentKind;
  runnerImage: string;
  setupScript?: string;
  serviceAccountName?: string;
  resources?: EnvironmentResources;
}

export interface RunExecutionSpec {
  runId: string;
  projectId: string;
  runType: RunType;
  attractorDefId: string;
  environment: RunExecutionEnvironment;
  sourceBranch: string;
  targetBranch: string;
  specBundleId?: string;
  modelConfig: RunModelConfig;
  secretsRef: string[];
  artifactPrefix: string;
}

export interface RunResult {
  runId: string;
  status: Extract<RunStatus, "SUCCEEDED" | "FAILED" | "CANCELED" | "TIMEOUT">;
  prUrl?: string;
  artifactManifestPath?: string;
  summary: string;
}

export function runQueueKey(): string {
  return "runs:queued";
}

export function runLockKey(projectId: string, branch: string): string {
  return `runs:lock:${projectId}:${branch}`;
}

export function runEventChannel(runId: string): string {
  return `runs:events:${runId}`;
}

export function runCancelKey(runId: string): string {
  return `runs:cancel:${runId}`;
}

export { attractorUsesDotImplementation } from "./dot-implementation.js";
