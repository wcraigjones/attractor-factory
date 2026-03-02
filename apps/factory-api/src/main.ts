import express from "express";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { KubeConfig, CoreV1Api, Exec } from "@kubernetes/client-node";
import { App as GitHubApp } from "@octokit/app";
import {
  AgentActionRisk,
  AgentActionStatus,
  AgentMessageRole,
  AgentScope,
  AttractorScope,
  EnvironmentKind,
  PrismaClient,
  ReviewDecision,
  RunQuestionStatus,
  RunStatus,
  RunType,
  TaskTemplateEnvironmentMode,
  TaskTemplateLaunchMode
} from "@prisma/client";
import { Redis } from "ioredis";
import {
  completeSimple,
  getModel,
  getModels,
  getProviders,
  Type,
  validateToolCall,
  type AssistantMessage,
  type Context,
  type Tool,
  type ToolCall
} from "@mariozechner/pi-ai";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { z } from "zod";
import {
  lintDotGraph,
  parseDotGraph,
  serializeDotGraphCanonical,
  type DotDiagnostic
} from "@attractor/dot-engine";
import {
  type EnvironmentResources,
  type RunExecutionEnvironment,
  attractorUsesDotImplementation,
  runCancelKey,
  runEventChannel,
  runLockKey,
  runQueueKey,
  type RunModelConfig
} from "@attractor/shared-types";
import {
  getProviderSecretSchema,
  listProviderSecretSchemas,
  materializeProviderSecretEnv,
  toProjectNamespace
} from "@attractor/shared-k8s";
import {
  FACTORY_AUTH_SESSION_COOKIE_NAME,
  parseCookieHeader,
  readSessionToken,
  resolveAuthConfig
} from "./auth.js";
import { clampPreviewBytes, isProbablyText, isTextByMetadata } from "./artifact-preview.js";
import {
  checkConclusionForDecision,
  effectiveReviewDecision,
  githubSyncConfigFromEnv,
  hasFeedbackText,
  inferPrRiskLevel,
  isReviewRunStale,
  issueTargetBranch,
  parseIssueNumbers,
  pullReviewStatus,
  reviewSummaryMarkdown,
  verifyGitHubWebhookSignature
} from "./github-sync.js";
import { assertReviewAttractorFlow } from "./review-attractor.js";
import {
  type ReviewCriticalSection,
  defaultReviewChecklistValue,
  extractCriticalSectionsFromDiff,
  rankReviewArtifacts,
  reviewChecklistTemplate,
  reviewSlaStatus,
  RUN_REVIEW_FRAMEWORK_VERSION,
  summarizeImplementationNote
} from "./run-review.js";
import {
  canonicalDedupeKey,
  isHumanActor,
  isValidIanaTimeZone,
  matchesTriggerRule,
  nextCronDate,
  parseTaskTemplateTriggerRules,
  type TaskTemplateBranchStrategy,
  type TaskTemplateTriggerContext,
  type TaskTemplateTriggerRule
} from "./task-templates.js";

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const execFileAsync = promisify(execFile);

const app = express();
const jsonBodyParser = express.json({ limit: "2mb" });
app.use((req, res, next) => {
  if (req.path === "/api/github/webhooks") {
    next();
    return;
  }
  jsonBodyParser(req, res, next);
});
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const authConfig = resolveAuthConfig(process.env);
if (authConfig.enabled) {
  process.stdout.write(`factory-api auth enabled for domain ${authConfig.allowedDomain}\n`);
}

app.use((req, res, next) => {
  if (!authConfig.enabled) {
    next();
    return;
  }
  if (req.path === "/healthz") {
    next();
    return;
  }
  if (req.method === "POST" && req.path === "/api/github/webhooks") {
    next();
    return;
  }
  const cookies = parseCookieHeader(req.headers.cookie);
  const session = readSessionToken(authConfig, cookies[FACTORY_AUTH_SESSION_COOKIE_NAME]);
  if (!session) {
    sendError(res, 401, "authentication required");
    return;
  }
  next();
});

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const FACTORY_VERSION = (process.env.FACTORY_VERSION ?? "").trim() || "unknown";
const RUNNER_DEFAULT_IMAGE =
  process.env.RUNNER_IMAGE ?? "ghcr.io/wcraigjones/attractor-factory-runner:latest";
const RUNNER_DEFAULT_SERVICE_ACCOUNT = process.env.RUNNER_SERVICE_ACCOUNT ?? "factory-runner";
const DEFAULT_ENVIRONMENT_NAME = process.env.DEFAULT_ENVIRONMENT_NAME ?? "default-k8s";
const GLOBAL_SECRET_NAMESPACE =
  process.env.GLOBAL_SECRET_NAMESPACE ?? process.env.FACTORY_SYSTEM_NAMESPACE ?? "factory-system";
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "factory-artifacts";
const SHELL_SESSION_TTL_SECONDS = Number(process.env.SHELL_SESSION_TTL_SECONDS ?? 1800);
const SHELL_POD_READY_TIMEOUT_SECONDS = Number(process.env.SHELL_POD_READY_TIMEOUT_SECONDS ?? 90);
const githubSyncConfig = githubSyncConfigFromEnv(process.env);
const GITHUB_APP_GLOBAL_SECRET_NAME = process.env.GITHUB_APP_GLOBAL_SECRET_NAME ?? "github-app";
const GITHUB_APP_MANIFEST_URL = "https://github.com/settings/apps/new";
const TASK_TEMPLATE_SCHEDULER_ENABLED =
  (process.env.TASK_TEMPLATE_SCHEDULER_ENABLED ?? "true").trim().toLowerCase() !== "false";
const TASK_TEMPLATE_SCHEDULER_INTERVAL_SECONDS = Math.max(
  5,
  Number.parseInt(process.env.TASK_TEMPLATE_SCHEDULER_INTERVAL_SECONDS ?? "30", 10) || 30
);
const TASK_TEMPLATE_SCHEDULER_BATCH_SIZE = Math.max(
  1,
  Math.min(500, Number.parseInt(process.env.TASK_TEMPLATE_SCHEDULER_BATCH_SIZE ?? "50", 10) || 50)
);
const AGENT_MODEL_PROVIDER = (process.env.AGENT_MODEL_PROVIDER ?? "google").trim();
const AGENT_MODEL_ID = (process.env.AGENT_MODEL_ID ?? "gemini-3.1-pro-preview").trim();
const AGENT_REASONING_LEVEL = (process.env.AGENT_REASONING_LEVEL ?? "high").trim().toLowerCase();
const AGENT_MAX_TOOL_ROUNDS = Math.max(
  1,
  Math.min(8, Number.parseInt(process.env.AGENT_MAX_TOOL_ROUNDS ?? "4", 10) || 4)
);
const AGENT_SHELL_TIMEOUT_SECONDS = Math.max(
  5,
  Math.min(600, Number.parseInt(process.env.AGENT_SHELL_TIMEOUT_SECONDS ?? "120", 10) || 120)
);
const AGENT_SHELL_MAX_OUTPUT_CHARS = Math.max(
  2_000,
  Math.min(200_000, Number.parseInt(process.env.AGENT_SHELL_MAX_OUTPUT_CHARS ?? "20000", 10) || 20000)
);
const AGENT_DEFAULT_SESSION_TITLE = "Factory Assistant";
const digestPinnedImagePattern = /@sha256:[a-f0-9]{64}$/i;
const imageTagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const environmentResourcesSchema = z.object({
  requests: z
    .object({
      cpu: z.string().min(1).optional(),
      memory: z.string().min(1).optional()
    })
    .optional(),
  limits: z
    .object({
      cpu: z.string().min(1).optional(),
      memory: z.string().min(1).optional()
    })
    .optional()
});
const createEnvironmentShellSessionSchema = z.object({
  mode: z.enum(["project", "system"]).default("project"),
  projectId: z.string().min(1).optional(),
  injectSecrets: z.boolean().optional()
});

type ShellSessionMode = "project" | "system";

interface EnvironmentShellSession {
  id: string;
  environmentId: string;
  mode: ShellSessionMode;
  projectId: string | null;
  namespace: string;
  podName: string;
  injectSecrets: boolean;
  connected: boolean;
  ttlTimer: ReturnType<typeof setTimeout>;
  stdin?: PassThrough;
  execSocket?: { close: () => void };
  clientSocket?: WebSocket;
}

const environmentShellSessions = new Map<string, EnvironmentShellSession>();

const minioClient = new S3Client({
  region: "us-east-1",
  endpoint: process.env.MINIO_ENDPOINT ?? "http://minio:9000",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY ?? "minioadmin",
    secretAccessKey: process.env.MINIO_SECRET_KEY ?? "minioadmin"
  }
});

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  const maybeTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof maybeTransform?.transformToByteArray === "function") {
    const bytes = await maybeTransform.transformToByteArray();
    return Buffer.from(bytes);
  }

  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error("Unsupported S3 object body stream");
}

async function getArtifactByRun(runId: string, artifactId: string) {
  return prisma.artifact.findFirst({
    where: {
      id: artifactId,
      runId
    }
  });
}

async function getObjectText(key: string): Promise<string | null> {
  try {
    const output = await minioClient.send(
      new GetObjectCommand({
        Bucket: MINIO_BUCKET,
        Key: key
      })
    );
    if (!output.Body) {
      return null;
    }
    const bytes = await bodyToBuffer(output.Body);
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

async function attractorSupportsDotImplementation(attractor: {
  contentPath: string | null;
}): Promise<boolean> {
  if (!attractor.contentPath) {
    return false;
  }
  const content = await getObjectText(attractor.contentPath);
  if (!content) {
    return false;
  }
  return attractorUsesDotImplementation(content);
}

let attractorBucketReady = false;

async function ensureAttractorBucket(): Promise<void> {
  if (attractorBucketReady) {
    return;
  }

  try {
    await minioClient.send(new HeadBucketCommand({ Bucket: MINIO_BUCKET }));
    attractorBucketReady = true;
    return;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const name = (error as { name?: string })?.name;
    if (status === 404 || name === "NotFound" || name === "NoSuchBucket") {
      await minioClient.send(new CreateBucketCommand({ Bucket: MINIO_BUCKET }));
      attractorBucketReady = true;
      return;
    }
    throw error;
  }
}

function sanitizeAttractorName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "attractor";
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function attractorObjectPath(args: {
  scope: "global" | "project";
  name: string;
  version: number;
  projectId?: string;
}): string {
  const safeName = sanitizeAttractorName(args.name);
  if (args.scope === "global") {
    return `attractors/global/${safeName}/v${args.version}.dot`;
  }
  if (!args.projectId) {
    throw new Error("projectId is required for project attractor object paths");
  }
  return `attractors/projects/${args.projectId}/${safeName}/v${args.version}.dot`;
}

async function putAttractorContent(objectPath: string, content: string): Promise<void> {
  await ensureAttractorBucket();
  await minioClient.send(
    new PutObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: objectPath,
      Body: content,
      ContentType: "text/vnd.graphviz"
    })
  );
}

function toNullableText(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

interface AttractorValidationPayload {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  diagnostics: DotDiagnostic[];
}

function parseAndLintAttractorContent(content: string): {
  content: string;
  validation: AttractorValidationPayload;
} {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return {
      content: "",
      validation: {
        valid: false,
        errorCount: 1,
        warningCount: 0,
        diagnostics: [
          {
            rule: "content_required",
            severity: "ERROR",
            message: "Attractor content must not be empty"
          }
        ]
      }
    };
  }

  try {
    const parsed = parseDotGraph(trimmed);
    const diagnostics = lintDotGraph(parsed);
    const errorCount = diagnostics.filter((item) => item.severity === "ERROR").length;
    const warningCount = diagnostics.filter((item) => item.severity === "WARNING").length;
    const canonical = serializeDotGraphCanonical(parsed);
    return {
      content: canonical,
      validation: {
        valid: errorCount === 0,
        errorCount,
        warningCount,
        diagnostics
      }
    };
  } catch (error) {
    return {
      content: trimmed,
      validation: {
        valid: false,
        errorCount: 1,
        warningCount: 0,
        diagnostics: [
          {
            rule: "parse_error",
            severity: "ERROR",
            message: error instanceof Error ? error.message : String(error)
          }
        ]
      }
    };
  }
}

async function loadAttractorContentFromStorage(contentPath: string | null): Promise<string | null> {
  if (!contentPath) {
    return null;
  }
  return getObjectText(contentPath);
}

function ensureAttractorContentValid(validation: AttractorValidationPayload): void {
  if (validation.valid) {
    return;
  }
  const message = validation.diagnostics
    .filter((item) => item.severity === "ERROR")
    .map((item) => item.message)
    .join("; ");
  throw new Error(message.length > 0 ? message : "attractor content failed validation");
}

async function resolveAttractorSnapshotForRun(attractor: {
  id: string;
  name: string;
  scope: AttractorScope;
  contentPath: string | null;
  contentVersion: number;
}): Promise<{ contentPath: string; contentVersion: number; contentSha256: string }> {
  if (!attractor.contentPath || attractor.contentVersion <= 0) {
    throw new Error(
      `Attractor ${attractor.name} is legacy-only (repoPath) and cannot be used for new runs`
    );
  }

  const versionRecord = await prisma.attractorDefVersion.findUnique({
    where: {
      attractorDefId_version: {
        attractorDefId: attractor.id,
        version: attractor.contentVersion
      }
    }
  });

  if (versionRecord) {
    return {
      contentPath: attractor.contentPath,
      contentVersion: attractor.contentVersion,
      contentSha256: versionRecord.contentSha256
    };
  }

  if (attractor.scope === AttractorScope.GLOBAL) {
    const global = await prisma.globalAttractor.findUnique({
      where: { name: attractor.name },
      select: { id: true }
    });
    if (global) {
      const globalVersion = await prisma.globalAttractorVersion.findUnique({
        where: {
          globalAttractorId_version: {
            globalAttractorId: global.id,
            version: attractor.contentVersion
          }
        }
      });
      if (globalVersion) {
        return {
          contentPath: attractor.contentPath,
          contentVersion: attractor.contentVersion,
          contentSha256: globalVersion.contentSha256
        };
      }
    }
  }

  const content = await loadAttractorContentFromStorage(attractor.contentPath);
  if (!content) {
    throw new Error(`Attractor storage content not found at ${attractor.contentPath}`);
  }

  return {
    contentPath: attractor.contentPath,
    contentVersion: attractor.contentVersion,
    contentSha256: digestText(content)
  };
}

function normalizeStoredChecklist(raw: unknown) {
  const base = defaultReviewChecklistValue();
  if (!raw || typeof raw !== "object") {
    return base;
  }

  const parsed = raw as Record<string, unknown>;
  return {
    summaryReviewed: parsed.summaryReviewed === true,
    criticalCodeReviewed: parsed.criticalCodeReviewed === true,
    artifactsReviewed: parsed.artifactsReviewed === true,
    functionalValidationReviewed: parsed.functionalValidationReviewed === true
  };
}

function hasProvider(provider: string): boolean {
  return getProviders().includes(provider as never);
}

function hasModel(provider: string, modelId: string): boolean {
  if (!hasProvider(provider)) {
    return false;
  }
  return getModels(provider as never).some((model) => model.id === modelId);
}

function normalizeAgentReasoningLevel(
  value: string
): RunModelConfig["reasoningLevel"] | undefined {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
}

if (!hasProvider(AGENT_MODEL_PROVIDER)) {
  throw new Error(`Unknown AGENT_MODEL_PROVIDER: ${AGENT_MODEL_PROVIDER}`);
}
if (!hasModel(AGENT_MODEL_PROVIDER, AGENT_MODEL_ID)) {
  throw new Error(
    `Unknown AGENT_MODEL_ID "${AGENT_MODEL_ID}" for provider "${AGENT_MODEL_PROVIDER}"`
  );
}
const agentModel = getModel(AGENT_MODEL_PROVIDER as never, AGENT_MODEL_ID as never);
if (!agentModel) {
  throw new Error(
    `Unable to resolve agent model ${AGENT_MODEL_PROVIDER}/${AGENT_MODEL_ID} from model catalog`
  );
}
const agentReasoningLevel =
  normalizeAgentReasoningLevel(AGENT_REASONING_LEVEL) ?? "high";

const runModelConfigSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  reasoningLevel: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional()
});

function normalizeRunModelConfig(config: RunModelConfig): RunModelConfig {
  if (!hasProvider(config.provider)) {
    throw new Error(`Unknown provider: ${config.provider}`);
  }
  if (!hasModel(config.provider, config.modelId)) {
    throw new Error(`Unknown model ${config.modelId} for provider ${config.provider}`);
  }
  if (
    config.reasoningLevel !== undefined &&
    !["minimal", "low", "medium", "high", "xhigh"].includes(config.reasoningLevel)
  ) {
    throw new Error("reasoningLevel must be one of minimal, low, medium, high, xhigh");
  }
  if (config.temperature !== undefined && (config.temperature < 0 || config.temperature > 2)) {
    throw new Error("temperature must be between 0 and 2");
  }
  if (config.maxTokens !== undefined && (!Number.isInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error("maxTokens must be a positive integer");
  }
  return config;
}

function requireAttractorModelConfig(input: {
  modelConfig: unknown;
  attractorName: string;
}): RunModelConfig {
  const parsed = runModelConfigSchema.safeParse(input.modelConfig);
  if (!parsed.success) {
    throw new Error(`Attractor ${input.attractorName} is missing a valid modelConfig`);
  }
  return normalizeRunModelConfig(parsed.data);
}

function isDigestPinnedImage(value: string): boolean {
  return digestPinnedImagePattern.test(value);
}

function isTaggedImage(value: string): boolean {
  if (value.includes("@")) {
    return false;
  }
  const lastSlash = value.lastIndexOf("/");
  const lastColon = value.lastIndexOf(":");
  if (lastColon <= lastSlash) {
    return false;
  }
  const name = value.slice(0, lastColon);
  const tag = value.slice(lastColon + 1);
  return name.length > 0 && imageTagPattern.test(tag);
}

function validateRunnerImageReference(value: string): string {
  if (!isDigestPinnedImage(value) && !isTaggedImage(value)) {
    throw new Error(
      "runnerImage must include a tag or digest (examples: ghcr.io/org/image:latest or ghcr.io/org/image@sha256:...)"
    );
  }
  return value;
}

function normalizeEnvironmentResources(value: unknown): EnvironmentResources | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = environmentResourcesSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

function toRunExecutionEnvironment(environment: {
  id: string;
  name: string;
  kind: EnvironmentKind;
  runnerImage: string;
  setupScript: string | null;
  serviceAccountName: string | null;
  resourcesJson: unknown;
}): RunExecutionEnvironment {
  const resources = normalizeEnvironmentResources(environment.resourcesJson);
  return {
    id: environment.id,
    name: environment.name,
    kind: environment.kind,
    runnerImage: environment.runnerImage,
    ...(environment.setupScript ? { setupScript: environment.setupScript } : {}),
    ...(environment.serviceAccountName ? { serviceAccountName: environment.serviceAccountName } : {}),
    ...(resources ? { resources } : {})
  };
}

async function ensureDefaultEnvironment() {
  const existing = await prisma.environment.findUnique({
    where: { name: DEFAULT_ENVIRONMENT_NAME }
  });
  if (existing) {
    return existing;
  }

  return prisma.environment.create({
    data: {
      name: DEFAULT_ENVIRONMENT_NAME,
      kind: EnvironmentKind.KUBERNETES_JOB,
      runnerImage: RUNNER_DEFAULT_IMAGE,
      serviceAccountName: RUNNER_DEFAULT_SERVICE_ACCOUNT,
      active: true
    }
  });
}

async function resolveProjectDefaultEnvironment(projectId: string, explicitEnvironmentId?: string) {
  if (explicitEnvironmentId) {
    const environment = await prisma.environment.findUnique({
      where: { id: explicitEnvironmentId }
    });
    if (!environment) {
      throw new Error("environment not found");
    }
    if (!environment.active) {
      throw new Error(`environment ${environment.name} is inactive`);
    }
    return environment;
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { defaultEnvironmentId: true }
  });
  if (!project) {
    throw new Error("project not found");
  }

  if (project.defaultEnvironmentId) {
    const environment = await prisma.environment.findUnique({
      where: { id: project.defaultEnvironmentId }
    });
    if (!environment) {
      throw new Error("project default environment no longer exists");
    }
    if (!environment.active) {
      throw new Error(`project default environment ${environment.name} is inactive`);
    }
    return environment;
  }

  const fallback = await ensureDefaultEnvironment();
  await prisma.project.update({
    where: { id: projectId },
    data: { defaultEnvironmentId: fallback.id }
  });
  return fallback;
}

async function resolveRunEnvironment(input: {
  projectId: string;
  explicitEnvironmentId?: string;
}): Promise<{ id: string; snapshot: RunExecutionEnvironment }> {
  const environment = await resolveProjectDefaultEnvironment(
    input.projectId,
    input.explicitEnvironmentId
  );

  return {
    id: environment.id,
    snapshot: toRunExecutionEnvironment(environment)
  };
}

function loadKubeConfig(): KubeConfig | null {
  if (process.env.K8S_ENABLED === "false") {
    return null;
  }
  try {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    return kc;
  } catch {
    return null;
  }
}

function getKubeApi(): CoreV1Api | null {
  const kc = loadKubeConfig();
  return kc ? kc.makeApiClient(CoreV1Api) : null;
}

async function ensureNamespace(name: string): Promise<void> {
  const kube = getKubeApi();
  if (!kube) {
    return;
  }

  try {
    await kube.readNamespace({ name });
  } catch {
    await kube.createNamespace({
      body: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name }
      }
    });
  }
}

async function upsertSecret(namespace: string, secretName: string, values: Record<string, string>) {
  const kube = getKubeApi();
  if (!kube) {
    return;
  }

  const body = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName,
      namespace
    },
    type: "Opaque",
    stringData: values
  };

  try {
    const existing = await kube.readNamespacedSecret({ name: secretName, namespace });
    await kube.replaceNamespacedSecret({ name: secretName, namespace, body: { ...body, metadata: existing.metadata } as never });
  } catch {
    await kube.createNamespacedSecret({ namespace, body: body as never });
  }
}

function toSecretName(prefix: string, name: string): string {
  return `${prefix}-${name.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
}

function decodeSecretData(data: Record<string, string> | undefined): Record<string, string> {
  if (!data) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, Buffer.from(value, "base64").toString("utf8")])
  );
}

async function readSecretValues(namespace: string, secretName: string): Promise<Record<string, string>> {
  const kube = getKubeApi();
  if (!kube) {
    return {};
  }
  const existing = await kube.readNamespacedSecret({ name: secretName, namespace });
  return decodeSecretData(existing.data as Record<string, string> | undefined);
}

async function syncGlobalSecretsToNamespace(namespace: string): Promise<void> {
  const globals = await prisma.globalSecret.findMany();
  for (const secret of globals) {
    try {
      const values = await readSecretValues(GLOBAL_SECRET_NAMESPACE, secret.k8sSecretName);
      if (Object.keys(values).length === 0) {
        continue;
      }
      await upsertSecret(namespace, secret.k8sSecretName, values);
    } catch (error) {
      process.stderr.write(
        `global secret sync skipped for ${secret.name} in namespace ${namespace}: ${error}\n`
      );
    }
  }
}

async function propagateGlobalSecretToAllProjects(secretName: string, values: Record<string, string>) {
  const projects = await prisma.project.findMany({ select: { namespace: true } });
  for (const project of projects) {
    await upsertSecret(project.namespace, secretName, values);
  }
}

async function upsertGlobalAttractorForProject(
  projectId: string,
  attractor: {
    name: string;
    repoPath: string | null;
    contentPath: string | null;
    contentVersion: number;
    defaultRunType: RunType;
    modelConfig: unknown | null;
    description: string | null;
    active: boolean;
  }
): Promise<void> {
  await prisma.attractorDef.upsert({
    where: {
      projectId_name_scope: {
        projectId,
        name: attractor.name,
        scope: AttractorScope.GLOBAL
      }
    },
    update: {
      repoPath: attractor.repoPath,
      contentPath: attractor.contentPath,
      contentVersion: attractor.contentVersion,
      defaultRunType: attractor.defaultRunType,
      modelConfig: attractor.modelConfig as never,
      description: attractor.description,
      active: attractor.active
    },
    create: {
      projectId,
      scope: AttractorScope.GLOBAL,
      name: attractor.name,
      repoPath: attractor.repoPath,
      contentPath: attractor.contentPath,
      contentVersion: attractor.contentVersion,
      defaultRunType: attractor.defaultRunType,
      modelConfig: attractor.modelConfig as never,
      description: attractor.description,
      active: attractor.active
    }
  });
}

async function syncGlobalAttractorsToProject(projectId: string): Promise<void> {
  const globals = await prisma.globalAttractor.findMany();
  for (const attractor of globals) {
    await upsertGlobalAttractorForProject(projectId, attractor);
  }
}

async function propagateGlobalAttractorToAllProjects(attractor: {
  name: string;
  repoPath: string | null;
  contentPath: string | null;
  contentVersion: number;
  defaultRunType: RunType;
  modelConfig: unknown | null;
  description: string | null;
  active: boolean;
}): Promise<void> {
  const projects = await prisma.project.findMany({ select: { id: true } });
  for (const project of projects) {
    await upsertGlobalAttractorForProject(project.id, attractor);
  }
}

type GlobalTaskTemplateInput = {
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
  triggersJson: unknown | null;
  description: string | null;
  active: boolean;
};

async function upsertGlobalTaskTemplateForProject(
  projectId: string,
  template: GlobalTaskTemplateInput
): Promise<void> {
  const schedule = normalizeTemplateScheduleInput({
    scheduleEnabled: template.scheduleEnabled,
    scheduleCron: template.scheduleCron,
    scheduleTimezone: template.scheduleTimezone
  });

  await prisma.taskTemplate.upsert({
    where: {
      projectId_name_scope: {
        projectId,
        name: template.name,
        scope: AttractorScope.GLOBAL
      }
    },
    update: {
      attractorName: template.attractorName,
      runType: template.runType,
      sourceBranch: template.sourceBranch,
      targetBranch: template.targetBranch,
      environmentMode: template.environmentMode,
      environmentName: template.environmentName,
      scheduleEnabled: template.scheduleEnabled,
      scheduleCron: schedule.scheduleCron,
      scheduleTimezone: schedule.scheduleTimezone,
      scheduleNextRunAt: schedule.scheduleNextRunAt,
      triggersJson: template.triggersJson as never,
      description: template.description,
      active: template.active
    },
    create: {
      projectId,
      scope: AttractorScope.GLOBAL,
      name: template.name,
      attractorName: template.attractorName,
      runType: template.runType,
      sourceBranch: template.sourceBranch,
      targetBranch: template.targetBranch,
      environmentMode: template.environmentMode,
      environmentName: template.environmentName,
      scheduleEnabled: template.scheduleEnabled,
      scheduleCron: schedule.scheduleCron,
      scheduleTimezone: schedule.scheduleTimezone,
      scheduleNextRunAt: schedule.scheduleNextRunAt,
      triggersJson: template.triggersJson as never,
      description: template.description,
      active: template.active
    }
  });
}

async function syncGlobalTaskTemplatesToProject(projectId: string): Promise<void> {
  const globals = await prisma.globalTaskTemplate.findMany();
  for (const template of globals) {
    await upsertGlobalTaskTemplateForProject(projectId, {
      name: template.name,
      attractorName: template.attractorName,
      runType: template.runType,
      sourceBranch: template.sourceBranch,
      targetBranch: template.targetBranch,
      environmentMode: template.environmentMode,
      environmentName: template.environmentName,
      scheduleEnabled: template.scheduleEnabled,
      scheduleCron: template.scheduleCron,
      scheduleTimezone: template.scheduleTimezone,
      triggersJson: template.triggersJson,
      description: template.description,
      active: template.active
    });
  }
}

async function propagateGlobalTaskTemplateToAllProjects(template: GlobalTaskTemplateInput): Promise<void> {
  const projects = await prisma.project.findMany({ select: { id: true } });
  for (const project of projects) {
    await upsertGlobalTaskTemplateForProject(project.id, template);
  }
}

async function hasEffectiveProviderSecret(projectId: string, provider: string): Promise<boolean> {
  const [projectSecret, globalSecret] = await Promise.all([
    prisma.projectSecret.findFirst({
      where: {
        projectId,
        provider
      }
    }),
    prisma.globalSecret.findFirst({
      where: {
        provider
      }
    })
  ]);

  return !!projectSecret || !!globalSecret;
}

function selectEffectiveRowsByName<T extends { name: string; scope: AttractorScope }>(rows: T[]): T[] {
  const projectByName = new Set(
    rows.filter((row) => row.scope === AttractorScope.PROJECT).map((row) => row.name)
  );
  return rows.filter((row) => {
    if (row.scope === AttractorScope.PROJECT) {
      return true;
    }
    return !projectByName.has(row.name);
  });
}

function buildTaskTemplateRows<T extends { id: string; name: string; scope: AttractorScope; active: boolean }>(
  templates: T[]
) {
  const projectByName = new Set(
    templates
      .filter((template) => template.scope === AttractorScope.PROJECT)
      .map((template) => template.name)
  );
  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    scope: template.scope,
    active: template.active,
    status:
      template.scope === AttractorScope.PROJECT
        ? "Project"
        : projectByName.has(template.name)
          ? "Overridden"
          : "Inherited"
  }));
}

function parseTemplateTriggersOrThrow(triggersJson: unknown): TaskTemplateTriggerRule[] {
  const parsed = parseTaskTemplateTriggerRules(triggersJson);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.join("; "));
  }
  return parsed.rules;
}

function normalizeTemplateScheduleInput(input: {
  scheduleEnabled: boolean;
  scheduleCron: string | null;
  scheduleTimezone: string | null;
  from?: Date;
}): { scheduleCron: string | null; scheduleTimezone: string | null; scheduleNextRunAt: Date | null } {
  const timezone = (input.scheduleTimezone ?? "").trim() || "UTC";
  const cron = (input.scheduleCron ?? "").trim() || null;
  if (!input.scheduleEnabled) {
    return {
      scheduleCron: cron,
      scheduleTimezone: timezone,
      scheduleNextRunAt: null
    };
  }
  if (!cron) {
    throw new Error("scheduleCron is required when scheduleEnabled=true");
  }
  if (!isValidIanaTimeZone(timezone)) {
    throw new Error(`invalid scheduleTimezone: ${timezone}`);
  }
  const scheduleNextRunAt = nextCronDate({
    cron,
    timeZone: timezone,
    from: input.from ?? new Date()
  });
  return {
    scheduleCron: cron,
    scheduleTimezone: timezone,
    scheduleNextRunAt
  };
}

async function resolveTemplateEnvironmentId(input: {
  projectId: string;
  environmentMode: TaskTemplateEnvironmentMode;
  environmentName: string | null;
}): Promise<string | undefined> {
  if (input.environmentMode === TaskTemplateEnvironmentMode.PROJECT_DEFAULT) {
    return undefined;
  }
  const environmentName = (input.environmentName ?? "").trim();
  if (!environmentName) {
    throw new Error("environmentName is required when environmentMode=NAMED");
  }
  const environment = await prisma.environment.findUnique({
    where: { name: environmentName }
  });
  if (!environment) {
    throw new Error(`environment ${environmentName} not found`);
  }
  if (!environment.active) {
    throw new Error(`environment ${environmentName} is inactive`);
  }
  return environment.id;
}

async function resolveEffectiveAttractorByName(projectId: string, name: string) {
  const projectAttractor = await prisma.attractorDef.findUnique({
    where: {
      projectId_name_scope: {
        projectId,
        name,
        scope: AttractorScope.PROJECT
      }
    }
  });
  if (projectAttractor) {
    return projectAttractor;
  }

  return prisma.attractorDef.findUnique({
    where: {
      projectId_name_scope: {
        projectId,
        name,
        scope: AttractorScope.GLOBAL
      }
    }
  });
}

type QueueTaskTemplateRunInput = {
  projectId: string;
  taskTemplateId: string;
  taskTemplateName: string;
  attractorName: string;
  runType: RunType;
  sourceBranch: string | null;
  targetBranch: string | null;
  environmentMode: TaskTemplateEnvironmentMode;
  environmentName: string | null;
  launchMode: TaskTemplateLaunchMode;
  githubIssueId?: string | null;
  githubPullRequestId?: string | null;
  triggerContext?: TaskTemplateTriggerContext | null;
  matchedRuleIds?: string[] | null;
  force?: boolean;
  specBundleId?: string | null;
};

async function queueRunFromTaskTemplate(input: QueueTaskTemplateRunInput): Promise<{
  runId: string;
  status: RunStatus;
}> {
  const project = await prisma.project.findUnique({ where: { id: input.projectId } });
  if (!project) {
    throw new Error("project not found");
  }

  const attractorDef = await resolveEffectiveAttractorByName(input.projectId, input.attractorName);
  if (!attractorDef) {
    throw new Error(`attractor ${input.attractorName} not found in project`);
  }
  if (!attractorDef.active) {
    throw new Error(`attractor ${input.attractorName} is inactive`);
  }

  const modelConfig = requireAttractorModelConfig({
    modelConfig: attractorDef.modelConfig,
    attractorName: attractorDef.name
  });
  const providerSecretExists = await hasEffectiveProviderSecret(project.id, modelConfig.provider);
  if (!providerSecretExists) {
    throw new Error(
      `Missing provider secret for ${modelConfig.provider}. Configure it in Project Secret or Global Secret UI first.`
    );
  }

  const attractorSnapshot = await resolveAttractorSnapshotForRun({
    id: attractorDef.id,
    name: attractorDef.name,
    scope: attractorDef.scope,
    contentPath: attractorDef.contentPath,
    contentVersion: attractorDef.contentVersion
  });

  let resolvedSpecBundleId = input.specBundleId ?? null;
  let dotImplementationWithoutSpecBundle = false;

  if (input.runType === RunType.planning && resolvedSpecBundleId) {
    throw new Error("planning runs must not set specBundleId");
  }
  if (input.runType === RunType.task && resolvedSpecBundleId) {
    throw new Error("task runs must not set specBundleId");
  }

  if (input.runType === RunType.implementation && !resolvedSpecBundleId) {
    dotImplementationWithoutSpecBundle = await attractorSupportsDotImplementation({
      contentPath: attractorDef.contentPath
    });
    if (!dotImplementationWithoutSpecBundle) {
      const latestPlanningRun = await prisma.run.findFirst({
        where: {
          projectId: project.id,
          runType: RunType.planning,
          status: RunStatus.SUCCEEDED,
          specBundleId: { not: null }
        },
        orderBy: { finishedAt: "desc" }
      });
      if (!latestPlanningRun?.specBundleId) {
        throw new Error("no successful planning run with a spec bundle is available");
      }
      resolvedSpecBundleId = latestPlanningRun.specBundleId;
    }
  }

  if (input.runType === RunType.implementation && !input.force) {
    const normalizedTargetBranch =
      (input.targetBranch ?? "").trim() || (input.sourceBranch ?? "").trim() || project.defaultBranch || "main";
    const collision = await prisma.run.findFirst({
      where: {
        projectId: project.id,
        runType: RunType.implementation,
        targetBranch: normalizedTargetBranch,
        status: { in: [RunStatus.QUEUED, RunStatus.RUNNING] }
      }
    });
    if (collision) {
      throw new Error(`Branch collision: run ${collision.id} is already active on ${normalizedTargetBranch}`);
    }
  }

  const sourceBranch = (input.sourceBranch ?? "").trim() || project.defaultBranch || "main";
  const targetBranch =
    input.runType === RunType.task
      ? sourceBranch
      : (input.targetBranch ?? "").trim() || sourceBranch;

  const explicitEnvironmentId = await resolveTemplateEnvironmentId({
    projectId: project.id,
    environmentMode: input.environmentMode,
    environmentName: input.environmentName
  });
  const resolvedEnvironment = await resolveRunEnvironment({
    projectId: project.id,
    explicitEnvironmentId
  });

  const run = await prisma.run.create({
    data: {
      projectId: project.id,
      attractorDefId: attractorDef.id,
      taskTemplateId: input.taskTemplateId,
      taskTemplateLaunchMode: input.launchMode,
      attractorContentPath: attractorSnapshot.contentPath,
      attractorContentVersion: attractorSnapshot.contentVersion,
      attractorContentSha256: attractorSnapshot.contentSha256,
      githubIssueId: input.githubIssueId ?? null,
      githubPullRequestId: input.githubPullRequestId ?? null,
      environmentId: resolvedEnvironment.id,
      environmentSnapshot: resolvedEnvironment.snapshot as never,
      runType: input.runType,
      sourceBranch,
      targetBranch,
      status: RunStatus.QUEUED,
      specBundleId: resolvedSpecBundleId
    }
  });

  await appendRunEvent(run.id, "RunQueued", {
    runId: run.id,
    runType: run.runType,
    projectId: run.projectId,
    targetBranch: run.targetBranch,
    dotImplementationWithoutSpecBundle,
    attractorSnapshot,
    modelConfig,
    environment: resolvedEnvironment.snapshot,
    runnerImage: resolvedEnvironment.snapshot.runnerImage,
    taskTemplate: {
      id: input.taskTemplateId,
      name: input.taskTemplateName,
      launchMode: input.launchMode
    }
  });
  await appendRunEvent(run.id, "TaskTemplateTriggered", {
    runId: run.id,
    taskTemplateId: input.taskTemplateId,
    taskTemplateName: input.taskTemplateName,
    launchMode: input.launchMode,
    matchedRuleIds: input.matchedRuleIds ?? [],
    trigger: input.triggerContext ?? null
  });
  if (input.launchMode === TaskTemplateLaunchMode.EVENT) {
    await appendRunEvent(run.id, "TaskTemplateMatched", {
      runId: run.id,
      taskTemplateId: input.taskTemplateId,
      taskTemplateName: input.taskTemplateName,
      matchedRuleIds: input.matchedRuleIds ?? [],
      trigger: input.triggerContext ?? null
    });
  }
  if (input.launchMode === TaskTemplateLaunchMode.SCHEDULE) {
    await appendRunEvent(run.id, "TaskTemplateScheduleDue", {
      runId: run.id,
      taskTemplateId: input.taskTemplateId,
      taskTemplateName: input.taskTemplateName
    });
  }
  if (input.launchMode === TaskTemplateLaunchMode.REPLAY) {
    await appendRunEvent(run.id, "TaskTemplateReplayTriggered", {
      runId: run.id,
      taskTemplateId: input.taskTemplateId,
      taskTemplateName: input.taskTemplateName,
      trigger: input.triggerContext ?? null
    });
  }

  await redis.lpush(runQueueKey(), run.id);
  return {
    runId: run.id,
    status: run.status
  };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPodRunning(input: {
  kube: CoreV1Api;
  namespace: string;
  podName: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastReason = "pod not yet running";
  while (Date.now() < deadline) {
    const pod = await input.kube.readNamespacedPod({
      name: input.podName,
      namespace: input.namespace
    });
    const phase = pod.status?.phase ?? "Unknown";
    if (phase === "Running") {
      return;
    }
    if (phase === "Failed" || phase === "Unknown") {
      lastReason = pod.status?.reason ?? `pod phase=${phase}`;
      break;
    }
    lastReason = pod.status?.reason ?? `pod phase=${phase}`;
    await waitMs(1000);
  }
  throw new Error(`shell pod did not become ready in time: ${lastReason}`);
}

async function resolveShellSecretEnv(input: {
  mode: ShellSessionMode;
  projectId?: string;
  injectSecrets: boolean;
}) {
  if (!input.injectSecrets) {
    return [];
  }

  const globalSecrets = await prisma.globalSecret.findMany();
  const globalMappings = globalSecrets
    .map((secret) => ({
      provider: secret.provider,
      secretName: secret.k8sSecretName,
      keys: secret.keyMappings as Record<string, string>
    }))
    .filter((mapping) => getProviderSecretSchema(mapping.provider) !== null);

  let mappings = globalMappings;
  if (input.mode === "project" && input.projectId) {
    const projectSecrets = await prisma.projectSecret.findMany({
      where: { projectId: input.projectId }
    });
    const projectMappings = projectSecrets
      .map((secret) => ({
        provider: secret.provider,
        secretName: secret.k8sSecretName,
        keys: secret.keyMappings as Record<string, string>
      }))
      .filter((mapping) => getProviderSecretSchema(mapping.provider) !== null);

    // Project mappings override global mappings for the same provider.
    const mappingsByProvider = new Map<string, { provider: string; secretName: string; keys: Record<string, string> }>();
    for (const mapping of globalMappings) {
      mappingsByProvider.set(mapping.provider, mapping);
    }
    for (const mapping of projectMappings) {
      mappingsByProvider.set(mapping.provider, mapping);
    }
    mappings = [...mappingsByProvider.values()];
  }

  return mappings
    .flatMap((mapping) => materializeProviderSecretEnv(mapping))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function deleteShellPod(namespace: string, podName: string): Promise<void> {
  const kube = getKubeApi();
  if (!kube) {
    return;
  }
  try {
    await kube.deleteNamespacedPod({
      name: podName,
      namespace
    });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== 404) {
      process.stderr.write(
        `shell pod cleanup failed namespace=${namespace} pod=${podName}: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    }
  }
}

async function terminateEnvironmentShellSession(
  sessionId: string,
  options: { closeClient?: boolean } = {}
): Promise<void> {
  const session = environmentShellSessions.get(sessionId);
  if (!session) {
    return;
  }
  environmentShellSessions.delete(sessionId);
  clearTimeout(session.ttlTimer);

  if (options.closeClient !== false && session.clientSocket && session.clientSocket.readyState === WebSocket.OPEN) {
    session.clientSocket.close(1000, "session ended");
  }
  session.stdin?.end();
  session.execSocket?.close();
  await deleteShellPod(session.namespace, session.podName);
}

function parseShellStreamPath(pathname: string): { sessionId: string } | null {
  const match = pathname.match(/^\/api\/environments\/shell\/sessions\/([^/]+)\/stream$/);
  if (!match) {
    return null;
  }
  return { sessionId: match[1] ?? "" };
}

async function appendRunEvent(runId: string, type: string, payload: unknown): Promise<void> {
  const event = await prisma.runEvent.create({
    data: {
      runId,
      type,
      payload: payload as never
    }
  });

  await redis.publish(
    runEventChannel(runId),
    JSON.stringify({
      id: event.id,
      runId,
      ts: event.ts.toISOString(),
      type,
      payload
    })
  );
}

interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  appSlug: string | null;
  webhookSecret: string | null;
  source: "env" | "global-secret";
}

function readMappedSecretValue(
  keyMappings: Record<string, string>,
  values: Record<string, string>,
  logicalKey: string
): string {
  const mapped = keyMappings[logicalKey] ?? logicalKey;
  return String(values[mapped] ?? "").trim();
}

async function loadGitHubAppCredentialsFromGlobalSecret(): Promise<GitHubAppCredentials | null> {
  const byName = await prisma.globalSecret.findUnique({
    where: { name: GITHUB_APP_GLOBAL_SECRET_NAME }
  });
  const fallback =
    byName ??
    (await prisma.globalSecret.findFirst({
      where: { provider: "github-app" },
      orderBy: { updatedAt: "desc" }
    }));
  if (!fallback) {
    return null;
  }

  let values: Record<string, string>;
  try {
    values = await readSecretValues(GLOBAL_SECRET_NAMESPACE, fallback.k8sSecretName);
  } catch {
    return null;
  }

  const keyMappings = (fallback.keyMappings ?? {}) as Record<string, string>;
  const appId = readMappedSecretValue(keyMappings, values, "appId");
  const privateKey = readMappedSecretValue(keyMappings, values, "privateKey");
  if (!appId || !privateKey) {
    return null;
  }

  const appSlug = readMappedSecretValue(keyMappings, values, "appSlug") || null;
  const webhookSecret = readMappedSecretValue(keyMappings, values, "webhookSecret") || null;

  return {
    appId,
    privateKey,
    appSlug,
    webhookSecret,
    source: "global-secret"
  };
}

async function resolveGitHubAppCredentials(): Promise<GitHubAppCredentials | null> {
  const envAppId = process.env.GITHUB_APP_ID?.trim() ?? "";
  const envPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim() ?? "";
  if (envAppId && envPrivateKey) {
    return {
      appId: envAppId,
      privateKey: envPrivateKey,
      appSlug: process.env.GITHUB_APP_SLUG?.trim() || null,
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET?.trim() || null,
      source: "env"
    };
  }

  return loadGitHubAppCredentialsFromGlobalSecret();
}

async function resolveGitHubWebhookSecret(): Promise<string | null> {
  const envSecret = process.env.GITHUB_WEBHOOK_SECRET?.trim() ?? "";
  if (envSecret) {
    return envSecret;
  }
  const credentials = await resolveGitHubAppCredentials();
  return credentials?.webhookSecret ?? null;
}

async function isGitHubSyncEnabled(): Promise<boolean> {
  const explicit = process.env.GITHUB_SYNC_ENABLED?.trim().toLowerCase();
  if (explicit === "true") {
    return true;
  }
  if (explicit === "false") {
    return false;
  }
  return (await resolveGitHubAppCredentials()) !== null;
}

async function githubApp(): Promise<GitHubApp | null> {
  const credentials = await resolveGitHubAppCredentials();
  if (!credentials) {
    return null;
  }
  return new GitHubApp({
    appId: credentials.appId,
    privateKey: credentials.privateKey.replace(/\\n/g, "\n")
  });
}

function requestOrigin(req: express.Request): string {
  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  const host = req.get("host");
  if (!host) {
    return "";
  }
  return `${req.protocol}://${host}`;
}

function parseGitHubProjectState(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "none") {
    return "";
  }

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { projectId?: unknown };
      if (typeof parsed.projectId === "string") {
        return parsed.projectId.trim();
      }
    } catch {
      return raw;
    }
  }

  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as { projectId?: unknown };
    if (typeof parsed.projectId === "string" && parsed.projectId.trim().length > 0) {
      return parsed.projectId.trim();
    }
  } catch {
    // Ignore non-encoded state.
  }

  return raw;
}

function buildProjectRedirectUrl(
  projectId: string,
  params?: Record<string, string | null | undefined>
): string {
  const basePath = `/projects/${encodeURIComponent(projectId)}`;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    const normalized = String(value ?? "").trim();
    if (normalized.length > 0) {
      query.set(key, normalized);
    }
  }
  const path = query.toString().length > 0 ? `${basePath}?${query.toString()}` : basePath;
  const webBase = process.env.FACTORY_WEB_BASE_URL?.trim().replace(/\/+$/, "");
  return webBase ? `${webBase}${path}` : path;
}

async function convertGitHubManifestCode(code: string): Promise<{
  appId: string;
  appSlug: string;
  privateKey: string;
  webhookSecret: string | null;
}> {
  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "attractor-factory-api"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub manifest conversion failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`
    );
  }

  const payload = (await response.json()) as {
    id?: number | string;
    slug?: string;
    pem?: string;
    webhook_secret?: string | null;
  };
  const appId = String(payload.id ?? "").trim();
  const appSlug = String(payload.slug ?? "").trim();
  const privateKey = String(payload.pem ?? "").trim();
  if (!appId || !appSlug || !privateKey) {
    throw new Error("GitHub manifest conversion response is missing app credentials");
  }

  return {
    appId,
    appSlug,
    privateKey,
    webhookSecret: payload.webhook_secret?.trim() || null
  };
}

async function upsertGitHubAppGlobalSecret(input: {
  appId: string;
  appSlug: string;
  privateKey: string;
  webhookSecret: string | null;
}): Promise<void> {
  const secretName = toSecretName("factory-global", GITHUB_APP_GLOBAL_SECRET_NAME);
  const values: Record<string, string> = {
    app_id: input.appId,
    app_slug: input.appSlug,
    private_key: input.privateKey
  };
  if (input.webhookSecret?.trim()) {
    values.webhook_secret = input.webhookSecret.trim();
  }

  const keyMappings: Record<string, string> = {
    appId: "app_id",
    appSlug: "app_slug",
    privateKey: "private_key",
    ...(values.webhook_secret ? { webhookSecret: "webhook_secret" } : {})
  };

  await upsertSecret(GLOBAL_SECRET_NAMESPACE, secretName, values);
  await propagateGlobalSecretToAllProjects(secretName, values);

  await prisma.globalSecret.upsert({
    where: { name: GITHUB_APP_GLOBAL_SECRET_NAME },
    update: {
      provider: "github-app",
      k8sSecretName: secretName,
      keyMappings: keyMappings as never
    },
    create: {
      name: GITHUB_APP_GLOBAL_SECRET_NAME,
      provider: "github-app",
      k8sSecretName: secretName,
      keyMappings: keyMappings as never
    }
  });
}

function parseRepoFullName(repoFullName: string): { owner: string; repo: string } | null {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    return null;
  }
  return { owner, repo };
}

function toNullableIsoDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeIssueLabels(
  labels: Array<string | { name?: string | null } | null | undefined> | null | undefined
): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }
  const normalized = labels
    .map((entry) => {
      if (!entry) {
        return "";
      }
      if (typeof entry === "string") {
        return entry.trim();
      }
      return typeof entry.name === "string" ? entry.name.trim() : "";
    })
    .filter((item) => item.length > 0);
  return [...new Set(normalized)].sort((a, b) => a.localeCompare(b));
}

async function upsertGitHubIssueForProject(input: {
  projectId: string;
  issue: {
    number: number;
    state: string;
    title: string;
    body?: string | null;
    user?: { login?: string | null } | null;
    labels?: Array<string | { name?: string | null } | null> | null;
    assignees?: Array<{ login?: string | null } | null> | null;
    html_url: string;
    created_at: string;
    closed_at?: string | null;
    updated_at: string;
  };
}) {
  const issue = input.issue;
  const assignees = (issue.assignees ?? [])
    .map((item) => item?.login?.trim() ?? "")
    .filter((item) => item.length > 0);

  const openedAt = toNullableIsoDate(issue.created_at) ?? new Date();
  const updatedAt = toNullableIsoDate(issue.updated_at) ?? new Date();

  return prisma.gitHubIssue.upsert({
    where: {
      projectId_issueNumber: {
        projectId: input.projectId,
        issueNumber: issue.number
      }
    },
    update: {
      state: issue.state,
      title: issue.title,
      body: issue.body ?? null,
      author: issue.user?.login ?? null,
      labelsJson: normalizeIssueLabels(issue.labels) as never,
      assigneesJson: assignees as never,
      url: issue.html_url,
      openedAt,
      closedAt: toNullableIsoDate(issue.closed_at),
      updatedAt,
      syncedAt: new Date()
    },
    create: {
      projectId: input.projectId,
      issueNumber: issue.number,
      state: issue.state,
      title: issue.title,
      body: issue.body ?? null,
      author: issue.user?.login ?? null,
      labelsJson: normalizeIssueLabels(issue.labels) as never,
      assigneesJson: assignees as never,
      url: issue.html_url,
      openedAt,
      closedAt: toNullableIsoDate(issue.closed_at),
      updatedAt,
      syncedAt: new Date()
    }
  });
}

async function resolveLinkedIssueIdForPullRequest(input: {
  projectId: string;
  title: string;
  body?: string | null;
}): Promise<string | null> {
  const refs = parseIssueNumbers(`${input.title}\n${input.body ?? ""}`);
  if (refs.length === 0) {
    return null;
  }
  const issue = await prisma.gitHubIssue.findFirst({
    where: {
      projectId: input.projectId,
      issueNumber: { in: refs }
    },
    orderBy: { issueNumber: "asc" }
  });
  return issue?.id ?? null;
}

async function upsertGitHubPullRequestForProject(input: {
  projectId: string;
  pullRequest: {
    number: number;
    state: string;
    title: string;
    body?: string | null;
    html_url: string;
    head: { ref: string; sha: string };
    base: { ref: string };
    created_at: string;
    closed_at?: string | null;
    merged_at?: string | null;
    updated_at: string;
  };
}) {
  const pr = input.pullRequest;
  const linkedIssueId = await resolveLinkedIssueIdForPullRequest({
    projectId: input.projectId,
    title: pr.title,
    body: pr.body ?? null
  });
  const openedAt = toNullableIsoDate(pr.created_at) ?? new Date();
  const updatedAt = toNullableIsoDate(pr.updated_at) ?? new Date();

  return prisma.gitHubPullRequest.upsert({
    where: {
      projectId_prNumber: {
        projectId: input.projectId,
        prNumber: pr.number
      }
    },
    update: {
      state: pr.state,
      title: pr.title,
      body: pr.body ?? null,
      url: pr.html_url,
      headRefName: pr.head.ref,
      headSha: pr.head.sha,
      baseRefName: pr.base.ref,
      mergedAt: toNullableIsoDate(pr.merged_at),
      openedAt,
      closedAt: toNullableIsoDate(pr.closed_at),
      updatedAt,
      syncedAt: new Date(),
      linkedIssueId
    },
    create: {
      projectId: input.projectId,
      prNumber: pr.number,
      state: pr.state,
      title: pr.title,
      body: pr.body ?? null,
      url: pr.html_url,
      headRefName: pr.head.ref,
      headSha: pr.head.sha,
      baseRefName: pr.base.ref,
      mergedAt: toNullableIsoDate(pr.merged_at),
      openedAt,
      closedAt: toNullableIsoDate(pr.closed_at),
      updatedAt,
      syncedAt: new Date(),
      linkedIssueId
    }
  });
}

async function triggerTaskTemplatesForEvent(input: {
  project: { id: string; defaultBranch: string | null };
  deliveryId: string | null;
  context: TaskTemplateTriggerContext;
  githubIssueId?: string | null;
  githubPullRequestId?: string | null;
}): Promise<void> {
  const allTemplates = await prisma.taskTemplate.findMany({
    where: {
      projectId: input.project.id
    },
    orderBy: [{ createdAt: "desc" }]
  });
  const templates = selectEffectiveRowsByName(allTemplates).filter((template) => template.active);
  for (const template of templates) {
    const { rules, errors } = parseTaskTemplateTriggerRules(template.triggersJson);
    if (errors.length > 0) {
      process.stderr.write(
        `task template ${template.id} trigger parse errors: ${errors.join("; ")}\n`
      );
      continue;
    }
    const matchedRules = rules.filter((rule) => matchesTriggerRule(rule, input.context));
    if (matchedRules.length === 0) {
      continue;
    }

    const dedupeKey = canonicalDedupeKey(input.context);
    const selectedRule = matchedRules[0];

    let ledger;
    try {
      ledger = await prisma.taskTemplateEventLedger.create({
        data: {
          projectId: input.project.id,
          taskTemplateId: template.id,
          eventName: input.context.event,
          eventAction: input.context.action ?? null,
          dedupeKey,
          deliveryId: input.deliveryId,
          entityType: input.context.issue
            ? "issue"
            : input.context.pullRequest
              ? "pull_request"
              : null,
          entityNumber: input.context.issue?.number ?? input.context.pullRequest?.number ?? null,
          matchedRuleIds: matchedRules.map((rule) => rule.id) as never,
          payload: {
            triggerContext: input.context,
            githubIssueId: input.githubIssueId ?? null,
            githubPullRequestId: input.githubPullRequestId ?? null
          } as never,
          status: "MATCHED"
        }
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "P2002") {
        continue;
      }
      throw error;
    }

    let sourceBranch = template.sourceBranch;
    let targetBranch = template.targetBranch;

    if (selectedRule.branchStrategy === "ISSUE_BRANCH") {
      if (!input.context.issue) {
        await prisma.taskTemplateEventLedger.update({
          where: { id: ledger.id },
          data: {
            status: "SKIPPED",
            reason: "ISSUE_BRANCH strategy selected but issue context was unavailable"
          }
        });
        continue;
      }
      sourceBranch = input.project.defaultBranch ?? "main";
      targetBranch = issueTargetBranch(input.context.issue.number, input.context.issue.title);
    }

    if (selectedRule.branchStrategy === "PR_HEAD") {
      if (!input.context.pullRequest) {
        await prisma.taskTemplateEventLedger.update({
          where: { id: ledger.id },
          data: {
            status: "SKIPPED",
            reason: "PR_HEAD strategy selected but pull request context was unavailable"
          }
        });
        continue;
      }
      sourceBranch = input.context.pullRequest.baseRefName || input.project.defaultBranch || "main";
      targetBranch = input.context.pullRequest.headRefName || sourceBranch;
    }

    try {
      const queued = await queueRunFromTaskTemplate({
        projectId: input.project.id,
        taskTemplateId: template.id,
        taskTemplateName: template.name,
        attractorName: template.attractorName,
        runType: template.runType,
        sourceBranch,
        targetBranch,
        environmentMode: template.environmentMode,
        environmentName: template.environmentName,
        launchMode: TaskTemplateLaunchMode.EVENT,
        githubIssueId: input.githubIssueId ?? null,
        githubPullRequestId: input.githubPullRequestId ?? null,
        triggerContext: input.context,
        matchedRuleIds: matchedRules.map((rule) => rule.id)
      });

      await prisma.taskTemplateEventLedger.update({
        where: { id: ledger.id },
        data: {
          runId: queued.runId,
          status: "TRIGGERED"
        }
      });
    } catch (error) {
      await prisma.taskTemplateEventLedger.update({
        where: { id: ledger.id },
        data: {
          status: "FAILED",
          reason: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
}

async function getInstallationOctokit(installationId: string) {
  const app = await githubApp();
  if (!app) {
    throw new Error("GitHub App credentials are not configured");
  }
  return app.getInstallationOctokit(Number(installationId));
}

async function reconcileProjectGitHub(projectId: string): Promise<{
  issuesSynced: number;
  pullRequestsSynced: number;
}> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { githubSyncState: true }
  });
  if (!project) {
    throw new Error("project not found");
  }
  if (!(await isGitHubSyncEnabled())) {
    throw new Error("GitHub sync is disabled");
  }
  if (!project.githubInstallationId || !project.repoFullName) {
    throw new Error("project/github installation not found");
  }

  const parsedRepo = parseRepoFullName(project.repoFullName);
  if (!parsedRepo) {
    throw new Error(`invalid repo full name ${project.repoFullName}`);
  }

  const octokit = await getInstallationOctokit(project.githubInstallationId);
  const now = new Date();
  const sinceIso = project.githubSyncState?.issuesCursor ?? undefined;

  let issuesSynced = 0;
  let pullRequestsSynced = 0;
  try {
    const issuesResponse = await octokit.request("GET /repos/{owner}/{repo}/issues", {
      owner: parsedRepo.owner,
      repo: parsedRepo.repo,
      state: "all",
      per_page: 100,
      ...(sinceIso ? { since: sinceIso } : {})
    });
    const issues = issuesResponse.data as Array<any>;

    for (const issue of issues) {
      // Pull requests are returned by this endpoint; ignore them here.
      if ("pull_request" in issue) {
        continue;
      }
      await upsertGitHubIssueForProject({
        projectId: project.id,
        issue: {
          number: issue.number,
          state: issue.state,
          title: issue.title,
          body: issue.body,
          user: issue.user ? { login: issue.user.login } : null,
          labels: issue.labels as Array<string | { name?: string | null } | null>,
          assignees: issue.assignees?.map((assignee: { login?: string | null }) => ({ login: assignee?.login })),
          html_url: issue.html_url,
          created_at: issue.created_at,
          closed_at: issue.closed_at,
          updated_at: issue.updated_at
        }
      });
      issuesSynced += 1;
    }

    const pullsResponse = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner: parsedRepo.owner,
      repo: parsedRepo.repo,
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: 100
    });
    const pulls = pullsResponse.data as Array<any>;

    for (const pull of pulls) {
      await upsertGitHubPullRequestForProject({
        projectId: project.id,
        pullRequest: {
          number: pull.number,
          state: pull.state,
          title: pull.title,
          body: pull.body,
          html_url: pull.html_url,
          head: { ref: pull.head.ref, sha: pull.head.sha },
          base: { ref: pull.base.ref },
          created_at: pull.created_at,
          closed_at: pull.closed_at,
          merged_at: pull.merged_at,
          updated_at: pull.updated_at
        }
      });
      pullRequestsSynced += 1;
    }

    await prisma.gitHubSyncState.upsert({
      where: { projectId: project.id },
      update: {
        issuesCursor: now.toISOString(),
        pullsCursor: now.toISOString(),
        lastIssueSyncAt: now,
        lastPullSyncAt: now,
        lastError: null
      },
      create: {
        projectId: project.id,
        issuesCursor: now.toISOString(),
        pullsCursor: now.toISOString(),
        lastIssueSyncAt: now,
        lastPullSyncAt: now,
        lastError: null
      }
    });
  } catch (error) {
    await prisma.gitHubSyncState.upsert({
      where: { projectId: project.id },
      update: {
        lastError: error instanceof Error ? error.message : String(error)
      },
      create: {
        projectId: project.id,
        lastError: error instanceof Error ? error.message : String(error)
      }
    });
    throw error;
  }

  return {
    issuesSynced,
    pullRequestsSynced
  };
}

async function buildRunReviewPack(runId: string) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      review: true,
      githubPullRequest: true
    }
  });
  if (!run) {
    return null;
  }

  const artifacts = await prisma.artifact.findMany({
    where: { runId: run.id },
    orderBy: { createdAt: "asc" }
  });
  const rankedArtifacts = rankReviewArtifacts(artifacts);
  const implementationPatchArtifact = artifacts.find((artifact) => artifact.key === "implementation.patch");
  const implementationNoteArtifact = artifacts.find((artifact) => artifact.key === "implementation-note.md");

  let criticalSections: ReviewCriticalSection[] = [];
  if (implementationPatchArtifact) {
    const patchText = await getObjectText(implementationPatchArtifact.path);
    if (patchText) {
      criticalSections = extractCriticalSectionsFromDiff(patchText);
    }
  }

  let summarySuggestion = "";
  if (implementationNoteArtifact) {
    const noteText = await getObjectText(implementationNoteArtifact.path);
    if (noteText) {
      summarySuggestion = summarizeImplementationNote(noteText);
    }
  }

  const sla = reviewSlaStatus(run.createdAt);
  return {
    run,
    review: run.review,
    checklistTemplate: reviewChecklistTemplate(),
    pack: {
      dueAt: sla.dueAt.toISOString(),
      overdue: sla.overdue,
      minutesRemaining: sla.minutesRemaining,
      summarySuggestion,
      artifactFocus: rankedArtifacts.slice(0, 8),
      criticalSections: criticalSections.slice(0, 20)
    }
  };
}

async function postReviewWriteback(reviewId: string): Promise<{
  githubCheckRunId: string | null;
  githubSummaryCommentId: string | null;
}> {
  const review = await prisma.runReview.findUnique({
    where: { id: reviewId },
    include: {
      run: {
        include: {
          project: true,
          githubPullRequest: true
        }
      }
    }
  });
  if (!review) {
    throw new Error("review not found");
  }
  if (!review.run.githubPullRequest || !review.run.project.repoFullName || !review.run.project.githubInstallationId) {
    return { githubCheckRunId: null, githubSummaryCommentId: null };
  }

  const parsed = parseRepoFullName(review.run.project.repoFullName);
  if (!parsed) {
    throw new Error(`Invalid repo full name ${review.run.project.repoFullName}`);
  }

  const octokit = await getInstallationOctokit(review.run.project.githubInstallationId);
  const check = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner: parsed.owner,
    repo: parsed.repo,
    name: "Attractor Review",
    head_sha: review.reviewedHeadSha ?? review.run.githubPullRequest.headSha,
    status: "completed",
    conclusion: checkConclusionForDecision(review.decision),
    output: {
      title: `Review ${review.decision}`,
      summary: (review.summary ?? "").slice(0, 65535),
      text: reviewSummaryMarkdown({
        runId: review.run.id,
        reviewer: review.reviewer,
        decision: review.decision,
        summary: review.summary,
        criticalFindings: review.criticalFindings,
        artifactFindings: review.artifactFindings,
        reviewedAtIso: review.reviewedAt.toISOString()
      }).slice(0, 65535)
    }
  });

  const comment = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner: parsed.owner,
    repo: parsed.repo,
    issue_number: review.run.githubPullRequest.prNumber,
    body: reviewSummaryMarkdown({
      runId: review.run.id,
      reviewer: review.reviewer,
      decision: review.decision,
      summary: review.summary,
      criticalFindings: review.criticalFindings,
      artifactFindings: review.artifactFindings,
      reviewedAtIso: review.reviewedAt.toISOString()
    })
  });

  return {
    githubCheckRunId: String(check.data.id),
    githubSummaryCommentId: String(comment.data.id)
  };
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function getRequestActorEmail(req: express.Request): string | null {
  if (!authConfig.enabled) {
    return null;
  }
  const cookies = parseCookieHeader(req.headers.cookie);
  const session = readSessionToken(authConfig, cookies[FACTORY_AUTH_SESSION_COOKIE_NAME]);
  return session?.email ?? null;
}

function clampAgentText(value: string, maxChars = 2000): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}…`;
}

function summarizeMessageContent(message: string, maxChars = 180): string {
  return clampAgentText(message.replace(/\s+/g, " ").trim(), maxChars);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function ensureProjectScopeSession(session: { scope: AgentScope; projectId: string | null }): string {
  if (session.scope !== AgentScope.PROJECT || !session.projectId) {
    throw new ApiError(400, "session is not project scoped; provide projectId explicitly");
  }
  return session.projectId;
}

function resolveAgentProjectId(
  session: { scope: AgentScope; projectId: string | null },
  maybeProjectId: unknown
): string {
  if (typeof maybeProjectId === "string" && maybeProjectId.trim().length > 0) {
    return maybeProjectId.trim();
  }
  return ensureProjectScopeSession(session);
}

function toAgentHistoryPrompt(messages: Array<{ role: AgentMessageRole; content: string; createdAt: Date }>): string {
  if (messages.length === 0) {
    return "(no prior chat history)";
  }
  return messages
    .map((message) => {
      const role = message.role.toLowerCase();
      const at = message.createdAt.toISOString();
      return `[${at}] ${role}: ${message.content}`;
    })
    .join("\n");
}

function textFromAssistantMessage(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

async function touchAgentSession(sessionId: string): Promise<void> {
  await prisma.agentSession.update({
    where: { id: sessionId },
    data: { updatedAt: new Date() }
  });
}

async function ensureAgentSession(sessionId: string) {
  const session = await prisma.agentSession.findUnique({
    where: { id: sessionId }
  });
  if (!session || session.archivedAt) {
    throw new ApiError(404, "agent session not found");
  }
  return session;
}

type AgentToolName =
  | "list_projects"
  | "get_project_overview"
  | "list_project_runs"
  | "list_project_pulls"
  | "list_project_issues"
  | "get_run_status"
  | "reconcile_project_github"
  | "redeploy_project"
  | "cancel_run"
  | "execute_shell";

const agentTools: Tool[] = [
  {
    name: "list_projects",
    description: "List projects in the factory.",
    parameters: Type.Object({})
  },
  {
    name: "get_project_overview",
    description: "Get high-level status for a project.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.String())
    })
  },
  {
    name: "list_project_runs",
    description: "List recent runs for a project.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      status: Type.Optional(Type.String())
    })
  },
  {
    name: "list_project_pulls",
    description: "List project pull requests from synchronized GitHub data.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.String()),
      state: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 }))
    })
  },
  {
    name: "list_project_issues",
    description: "List project issues from synchronized GitHub data.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.String()),
      state: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 }))
    })
  },
  {
    name: "get_run_status",
    description: "Get detailed status for a run including recent events.",
    parameters: Type.Object({
      runId: Type.String()
    })
  },
  {
    name: "reconcile_project_github",
    description: "Sync GitHub issues and pull requests for a project now.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.String())
    })
  },
  {
    name: "redeploy_project",
    description:
      "Redeploy a project using its configured redeploy defaults. This requires explicit approval.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.String()),
      force: Type.Optional(Type.Boolean())
    })
  },
  {
    name: "cancel_run",
    description: "Cancel an active run. This requires explicit approval.",
    parameters: Type.Object({
      runId: Type.String()
    })
  },
  {
    name: "execute_shell",
    description: "Execute a shell command from the API workspace root. Requires explicit approval.",
    parameters: Type.Object({
      command: Type.String(),
      cwd: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 5, maximum: 600 }))
    })
  }
];

const highRiskAgentTools = new Set<AgentToolName>([
  "redeploy_project",
  "cancel_run",
  "execute_shell"
]);

function isHighRiskAgentTool(toolName: string): toolName is AgentToolName {
  return highRiskAgentTools.has(toolName as AgentToolName);
}

function parseLimit(value: unknown, fallback: number, max = 100): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(max, parsed);
}

function ensureWorkspacePath(cwd: string | undefined): string {
  const root = process.cwd();
  if (!cwd || cwd.trim().length === 0) {
    return root;
  }
  const resolved = resolve(root, cwd);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new ApiError(400, "cwd must stay within the API workspace");
  }
  return resolved;
}

async function executeAgentShellCommand(args: {
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
}) {
  const command = args.command.trim();
  if (!command) {
    throw new ApiError(400, "command is required");
  }
  const cwd = ensureWorkspacePath(args.cwd);
  const timeoutSeconds = Math.max(
    5,
    Math.min(
      600,
      Number.parseInt(String(args.timeoutSeconds ?? AGENT_SHELL_TIMEOUT_SECONDS), 10) ||
        AGENT_SHELL_TIMEOUT_SECONDS
    )
  );
  const startedAt = Date.now();

  try {
    const result = await execFileAsync("bash", ["-lc", command], {
      cwd,
      timeout: timeoutSeconds * 1000,
      maxBuffer: 4 * 1024 * 1024
    });
    return {
      command,
      cwd,
      timeoutSeconds,
      exitCode: 0,
      stdout: clampAgentText(result.stdout ?? "", AGENT_SHELL_MAX_OUTPUT_CHARS),
      stderr: clampAgentText(result.stderr ?? "", AGENT_SHELL_MAX_OUTPUT_CHARS),
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    const typed = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    throw new ApiError(
      400,
      `shell command failed (code=${String(typed.code ?? "unknown")}): ${summarizeMessageContent(typed.stderr ?? typed.message ?? "command error", 320)}`
    );
  }
}

async function queueSelfIterateImplementationRun(input: {
  projectId: string;
  attractorDefId: string;
  environmentId?: string;
  sourceBranch: string;
  targetBranch: string;
  force?: boolean;
}): Promise<{
  runId: string;
  status: RunStatus;
  sourcePlanningRunId: string;
  sourceSpecBundleId: string;
}> {
  const project = await prisma.project.findUnique({ where: { id: input.projectId } });
  if (!project) {
    throw new ApiError(404, "project not found");
  }

  const attractorDef = await prisma.attractorDef.findUnique({ where: { id: input.attractorDefId } });
  if (!attractorDef || attractorDef.projectId !== project.id) {
    throw new ApiError(404, "attractor definition not found in project");
  }
  if (!attractorDef.active) {
    throw new ApiError(409, "attractor definition is inactive");
  }

  let modelConfig: RunModelConfig;
  try {
    modelConfig = requireAttractorModelConfig({
      modelConfig: attractorDef.modelConfig,
      attractorName: attractorDef.name
    });
  } catch (error) {
    throw new ApiError(409, error instanceof Error ? error.message : String(error));
  }

  const providerSecretExists = await hasEffectiveProviderSecret(project.id, modelConfig.provider);
  if (!providerSecretExists) {
    throw new ApiError(
      409,
      `Missing provider secret for ${modelConfig.provider}. Configure it in Project Secret or Global Secret UI first.`
    );
  }

  let attractorSnapshot: { contentPath: string; contentVersion: number; contentSha256: string };
  try {
    attractorSnapshot = await resolveAttractorSnapshotForRun({
      id: attractorDef.id,
      name: attractorDef.name,
      scope: attractorDef.scope,
      contentPath: attractorDef.contentPath,
      contentVersion: attractorDef.contentVersion
    });
  } catch (error) {
    throw new ApiError(409, error instanceof Error ? error.message : String(error));
  }

  const latestPlanningRun = await prisma.run.findFirst({
    where: {
      projectId: project.id,
      runType: RunType.planning,
      status: RunStatus.SUCCEEDED,
      specBundleId: { not: null }
    },
    orderBy: {
      finishedAt: "desc"
    }
  });
  if (!latestPlanningRun?.specBundleId) {
    throw new ApiError(409, "no successful planning run with a spec bundle is available");
  }

  if (!input.force) {
    const collision = await prisma.run.findFirst({
      where: {
        projectId: project.id,
        runType: RunType.implementation,
        targetBranch: input.targetBranch,
        status: { in: [RunStatus.QUEUED, RunStatus.RUNNING] }
      }
    });
    if (collision) {
      throw new ApiError(
        409,
        `Branch collision: run ${collision.id} is already active on ${input.targetBranch}`
      );
    }
  }

  let resolvedEnvironment: { id: string; snapshot: RunExecutionEnvironment };
  try {
    resolvedEnvironment = await resolveRunEnvironment({
      projectId: project.id,
      explicitEnvironmentId: input.environmentId
    });
  } catch (error) {
    throw new ApiError(409, error instanceof Error ? error.message : String(error));
  }

  const run = await prisma.run.create({
    data: {
      projectId: project.id,
      attractorDefId: attractorDef.id,
      attractorContentPath: attractorSnapshot.contentPath,
      attractorContentVersion: attractorSnapshot.contentVersion,
      attractorContentSha256: attractorSnapshot.contentSha256,
      environmentId: resolvedEnvironment.id,
      environmentSnapshot: resolvedEnvironment.snapshot as never,
      runType: RunType.implementation,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      status: RunStatus.QUEUED,
      specBundleId: latestPlanningRun.specBundleId
    }
  });

  await appendRunEvent(run.id, "RunQueued", {
    runId: run.id,
    runType: run.runType,
    projectId: run.projectId,
    targetBranch: run.targetBranch,
    attractorSnapshot,
    modelConfig,
    environment: resolvedEnvironment.snapshot,
    runnerImage: resolvedEnvironment.snapshot.runnerImage,
    sourcePlanningRunId: latestPlanningRun.id,
    sourceSpecBundleId: latestPlanningRun.specBundleId
  });
  await redis.lpush(runQueueKey(), run.id);

  return {
    runId: run.id,
    status: run.status,
    sourcePlanningRunId: latestPlanningRun.id,
    sourceSpecBundleId: latestPlanningRun.specBundleId
  };
}

async function executeRedeployFromProjectDefaults(input: {
  projectId: string;
  force?: boolean;
}) {
  const project = await prisma.project.findUnique({
    where: { id: input.projectId }
  });
  if (!project) {
    throw new ApiError(404, "project not found");
  }
  if (!project.redeployAttractorId) {
    throw new ApiError(409, "project redeploy defaults are not configured (missing attractor)");
  }
  if (!project.redeploySourceBranch || !project.redeployTargetBranch) {
    throw new ApiError(
      409,
      "project redeploy defaults are not configured (missing source/target branch)"
    );
  }

  return queueSelfIterateImplementationRun({
    projectId: project.id,
    attractorDefId: project.redeployAttractorId,
    sourceBranch: project.redeploySourceBranch,
    targetBranch: project.redeployTargetBranch,
    environmentId: project.redeployEnvironmentId ?? undefined,
    force: input.force
  });
}

async function cancelRunInternal(runId: string): Promise<{ runId: string; status: RunStatus }> {
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) {
    throw new ApiError(404, "run not found");
  }
  if (run.status !== RunStatus.QUEUED && run.status !== RunStatus.RUNNING) {
    throw new ApiError(409, `run is already terminal (${run.status})`);
  }

  const updated = await prisma.run.update({
    where: { id: run.id },
    data: {
      status: RunStatus.CANCELED,
      finishedAt: new Date()
    }
  });
  await redis.set(runCancelKey(run.id), "1", "EX", 7200);
  await appendRunEvent(run.id, "RunCanceled", { runId: run.id });
  if (run.runType === RunType.implementation) {
    await redis.del(runLockKey(run.projectId, run.targetBranch));
  }
  return { runId: updated.id, status: updated.status };
}

async function executeReadAgentTool(
  toolName: AgentToolName,
  rawArgs: unknown,
  session: { scope: AgentScope; projectId: string | null }
): Promise<unknown> {
  const args = asRecord(rawArgs);

  if (toolName === "list_projects") {
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: "desc" },
      take: 200
    });
    return { projects };
  }

  if (toolName === "get_project_overview") {
    const projectId = resolveAgentProjectId(session, args.projectId);
    const project = await prisma.project.findUnique({
      where: { id: projectId }
    });
    if (!project) {
      throw new ApiError(404, "project not found");
    }
    const [runCount, activeRunCount, issueCount, pullCount, attractorCount] = await Promise.all([
      prisma.run.count({ where: { projectId: project.id } }),
      prisma.run.count({
        where: { projectId: project.id, status: { in: [RunStatus.QUEUED, RunStatus.RUNNING] } }
      }),
      prisma.gitHubIssue.count({ where: { projectId: project.id } }),
      prisma.gitHubPullRequest.count({ where: { projectId: project.id } }),
      prisma.attractorDef.count({ where: { projectId: project.id, active: true } })
    ]);
    return {
      project,
      counts: {
        runs: runCount,
        activeRuns: activeRunCount,
        issues: issueCount,
        pulls: pullCount,
        activeAttractors: attractorCount
      }
    };
  }

  if (toolName === "list_project_runs") {
    const projectId = resolveAgentProjectId(session, args.projectId);
    const take = parseLimit(args.limit, 20, 100);
    const status = typeof args.status === "string" ? args.status.trim().toUpperCase() : "";
    if (
      status.length > 0 &&
      ![
        RunStatus.QUEUED,
        RunStatus.RUNNING,
        RunStatus.SUCCEEDED,
        RunStatus.FAILED,
        RunStatus.CANCELED,
        RunStatus.TIMEOUT
      ].includes(status as RunStatus)
    ) {
      throw new ApiError(400, `invalid run status filter: ${status}`);
    }
    const runs = await prisma.run.findMany({
      where: {
        projectId,
        ...(status.length > 0 ? { status: status as RunStatus } : {})
      },
      include: {
        githubIssue: true,
        githubPullRequest: true
      },
      orderBy: { createdAt: "desc" },
      take
    });
    return { runs };
  }

  if (toolName === "list_project_pulls") {
    const projectId = resolveAgentProjectId(session, args.projectId);
    const take = parseLimit(args.limit, 20, 100);
    const state = typeof args.state === "string" ? args.state.trim().toLowerCase() : "all";
    const pulls = await prisma.gitHubPullRequest.findMany({
      where: {
        projectId,
        ...(state === "all" ? {} : { state })
      },
      orderBy: { openedAt: "desc" },
      take
    });
    return { pulls };
  }

  if (toolName === "list_project_issues") {
    const projectId = resolveAgentProjectId(session, args.projectId);
    const take = parseLimit(args.limit, 20, 100);
    const state = typeof args.state === "string" ? args.state.trim().toLowerCase() : "all";
    const issues = await prisma.gitHubIssue.findMany({
      where: {
        projectId,
        ...(state === "all" ? {} : { state })
      },
      orderBy: { updatedAt: "desc" },
      take
    });
    return { issues };
  }

  if (toolName === "get_run_status") {
    const runId = String(args.runId ?? "").trim();
    if (!runId) {
      throw new ApiError(400, "runId is required");
    }
    const run = await prisma.run.findUnique({
      where: { id: runId },
      include: {
        githubIssue: true,
        githubPullRequest: true,
        events: {
          orderBy: { ts: "desc" },
          take: 30
        }
      }
    });
    if (!run) {
      throw new ApiError(404, "run not found");
    }
    return { run };
  }

  if (toolName === "reconcile_project_github") {
    const projectId = resolveAgentProjectId(session, args.projectId);
    const result = await reconcileProjectGitHub(projectId);
    return result;
  }

  throw new ApiError(400, `unsupported read tool: ${toolName}`);
}

function summarizePendingAgentAction(toolName: AgentToolName, rawArgs: unknown): string {
  const args = asRecord(rawArgs);
  if (toolName === "redeploy_project") {
    return `Redeploy project ${String(args.projectId ?? "").trim() || "(session project)"}`;
  }
  if (toolName === "cancel_run") {
    return `Cancel run ${String(args.runId ?? "").trim() || "(unknown run)"}`;
  }
  if (toolName === "execute_shell") {
    return `Execute shell command: ${summarizeMessageContent(String(args.command ?? ""), 120)}`;
  }
  return `Execute action ${toolName}`;
}

async function executeApprovedAgentAction(action: {
  type: string;
  argsJson: unknown;
}, session: {
  scope: AgentScope;
  projectId: string | null;
}) {
  const args = asRecord(action.argsJson);
  if (action.type === "redeploy_project") {
    const projectId = resolveAgentProjectId(session, args.projectId);
    return executeRedeployFromProjectDefaults({
      projectId,
      force: args.force === true
    });
  }
  if (action.type === "cancel_run") {
    const runId = String(args.runId ?? "").trim();
    if (!runId) {
      throw new ApiError(400, "cancel_run requires runId");
    }
    return cancelRunInternal(runId);
  }
  if (action.type === "execute_shell") {
    const command = String(args.command ?? "").trim();
    if (!command) {
      throw new ApiError(400, "execute_shell requires command");
    }
    return executeAgentShellCommand({
      command,
      cwd: typeof args.cwd === "string" ? args.cwd : undefined,
      timeoutSeconds: Number.parseInt(String(args.timeoutSeconds ?? ""), 10) || undefined
    });
  }
  throw new ApiError(400, `unsupported action type: ${action.type}`);
}

async function runAgentTurn(input: {
  session: {
    id: string;
    scope: AgentScope;
    projectId: string | null;
    title: string;
  };
  userMessage: string;
  actorEmail: string | null;
}): Promise<{
  assistantText: string;
  usage: unknown;
  pendingActions: string[];
}> {
  const historyMessages = await prisma.agentMessage.findMany({
    where: { sessionId: input.session.id },
    orderBy: { createdAt: "desc" },
    take: 30
  });
  const history = [...historyMessages].reverse();
  const historyPrompt = toAgentHistoryPrompt(
    history.map((message) => ({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt
    }))
  );

  const scopeLine =
    input.session.scope === AgentScope.PROJECT
      ? `PROJECT session for projectId=${input.session.projectId}`
      : "GLOBAL session";
  const systemPrompt = [
    "You are the Attractor Factory assistant.",
    "Use tools for factual questions about runs, PRs, issues, and project state.",
    "For mutating actions, call the tool and the backend will require explicit approval.",
    "Keep responses concise and operationally clear.",
    `Session scope: ${scopeLine}.`
  ].join(" ");

  const context: Context = {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: `Recent chat history:\n${historyPrompt}\n\nUser message:\n${input.userMessage}`,
        timestamp: Date.now()
      }
    ],
    tools: agentTools
  };

  let lastMessage: AssistantMessage | null = null;
  const pendingActionIds: string[] = [];
  for (let round = 0; round < AGENT_MAX_TOOL_ROUNDS; round += 1) {
    const response = await completeSimple(agentModel, context, {
      reasoning: agentReasoningLevel
    });
    lastMessage = response;
    context.messages.push(response);

    const toolCalls = response.content.filter((block): block is ToolCall => block.type === "toolCall");
    if (toolCalls.length === 0) {
      break;
    }

    for (const toolCall of toolCalls) {
      let args: unknown;
      try {
        args = validateToolCall(agentTools, toolCall);
      } catch (error) {
        context.messages.push({
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error)
              })
            }
          ],
          isError: true,
          timestamp: Date.now()
        });
        continue;
      }

      const toolName = toolCall.name as AgentToolName;
      if (isHighRiskAgentTool(toolName)) {
        let actionArgs = args;
        if (toolName === "redeploy_project") {
          const actionArgsRecord = asRecord(args);
          const explicitProjectId = String(actionArgsRecord.projectId ?? "").trim();
          if (!explicitProjectId && input.session.scope === AgentScope.PROJECT && input.session.projectId) {
            actionArgs = {
              ...actionArgsRecord,
              projectId: input.session.projectId
            };
          }
        }

        const action = await prisma.agentAction.create({
          data: {
            sessionId: input.session.id,
            type: toolName,
            risk: AgentActionRisk.HIGH,
            status: AgentActionStatus.PENDING,
            summary: summarizePendingAgentAction(toolName, actionArgs),
            argsJson: (actionArgs ?? {}) as never,
            requestedByEmail: input.actorEmail
          }
        });
        await touchAgentSession(input.session.id);
        pendingActionIds.push(action.id);
        context.messages.push({
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                pendingApproval: true,
                actionId: action.id,
                summary: action.summary
              })
            }
          ],
          isError: false,
          timestamp: Date.now()
        });
        continue;
      }

      try {
        const result = await executeReadAgentTool(toolName, args, input.session);
        context.messages.push({
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ],
          isError: false,
          timestamp: Date.now()
        });
      } catch (error) {
        context.messages.push({
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error)
              })
            }
          ],
          isError: true,
          timestamp: Date.now()
        });
      }
    }
  }

  const assistantText = lastMessage
    ? textFromAssistantMessage(lastMessage)
    : "I could not complete that request.";
  return {
    assistantText:
      assistantText.length > 0
        ? assistantText
        : "I reviewed the request and queued the required tool actions.",
    usage: lastMessage?.usage ?? null,
    pendingActions: pendingActionIds
  };
}

function sendError(res: express.Response, status: number, error: string) {
  res.status(status).json({ error });
}

app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    service: "factory-api",
    version: FACTORY_VERSION,
    runnerImage: RUNNER_DEFAULT_IMAGE
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    status: "ok",
    service: "factory-api",
    version: FACTORY_VERSION
  });
});

app.get("/api/models/providers", (_req, res) => {
  const providers = [...getProviders()].sort();
  res.json({ providers });
});

app.get("/api/models", (req, res) => {
  const provider = String(req.query.provider ?? "");
  if (!provider) {
    return sendError(res, 400, "provider query parameter is required");
  }
  if (!hasProvider(provider)) {
    return sendError(res, 404, `Unknown provider: ${provider}`);
  }

  const models = getModels(provider as never)
    .map((m) => ({ id: m.id, name: m.name, provider: m.provider, api: m.api }))
    .sort((a, b) => a.id.localeCompare(b.id));

  res.json({ provider, models });
});

app.get("/api/secrets/providers", (_req, res) => {
  res.json({ providers: listProviderSecretSchemas() });
});

app.get("/api/secrets/providers/:provider", (req, res) => {
  const schema = getProviderSecretSchema(req.params.provider);
  if (!schema) {
    return sendError(res, 404, `Unknown provider secret mapping: ${req.params.provider}`);
  }
  res.json(schema);
});

const createEnvironmentSchema = z.object({
  name: z.string().min(2).max(80),
  kind: z.enum(["KUBERNETES_JOB"]).default("KUBERNETES_JOB"),
  runnerImage: z.string().min(1),
  setupScript: z.string().max(20000).optional(),
  serviceAccountName: z.string().min(1).optional(),
  resourcesJson: environmentResourcesSchema.optional(),
  active: z.boolean().optional()
});

const patchEnvironmentSchema = z
  .object({
    name: z.string().min(2).max(80).optional(),
    runnerImage: z.string().min(1).optional(),
    setupScript: z.string().max(20000).nullable().optional(),
    serviceAccountName: z.string().min(1).nullable().optional(),
    resourcesJson: environmentResourcesSchema.optional(),
    active: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field is required"
  });

app.get("/api/environments", async (_req, res) => {
  await ensureDefaultEnvironment();
  const environments = await prisma.environment.findMany({
    orderBy: { createdAt: "desc" }
  });
  res.json({ environments });
});

app.post("/api/environments", async (req, res) => {
  const input = createEnvironmentSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  try {
    validateRunnerImageReference(input.data.runnerImage);
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  try {
    const environment = await prisma.environment.create({
      data: {
        name: input.data.name,
        kind: input.data.kind,
        runnerImage: input.data.runnerImage,
        setupScript: toNullableText(input.data.setupScript),
        serviceAccountName: input.data.serviceAccountName,
        resourcesJson: input.data.resourcesJson,
        active: input.data.active ?? true
      }
    });
    res.status(201).json(environment);
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

app.patch("/api/environments/:environmentId", async (req, res) => {
  const input = patchEnvironmentSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  if (input.data.runnerImage) {
    try {
      validateRunnerImageReference(input.data.runnerImage);
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
  }

  try {
    const updated = await prisma.environment.update({
      where: { id: req.params.environmentId },
      data: {
        ...(input.data.name !== undefined ? { name: input.data.name } : {}),
        ...(input.data.runnerImage !== undefined ? { runnerImage: input.data.runnerImage } : {}),
        ...(input.data.setupScript !== undefined
          ? { setupScript: toNullableText(input.data.setupScript ?? undefined) }
          : {}),
        ...(input.data.serviceAccountName !== undefined
          ? { serviceAccountName: input.data.serviceAccountName }
          : {}),
        ...(input.data.resourcesJson !== undefined ? { resourcesJson: input.data.resourcesJson } : {}),
        ...(input.data.active !== undefined ? { active: input.data.active } : {})
      }
    });
    res.json(updated);
  } catch (error) {
    return sendError(res, 404, error instanceof Error ? error.message : String(error));
  }
});

app.post("/api/environments/:environmentId/shell/sessions", async (req, res) => {
  const input = createEnvironmentShellSessionSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  const kube = getKubeApi();
  if (!kube) {
    return sendError(res, 409, "kubernetes is not available");
  }

  const environment = await prisma.environment.findUnique({
    where: { id: req.params.environmentId }
  });
  if (!environment) {
    return sendError(res, 404, "environment not found");
  }
  if (!environment.active) {
    return sendError(res, 409, `environment ${environment.name} is inactive`);
  }
  if (environment.kind !== EnvironmentKind.KUBERNETES_JOB) {
    return sendError(res, 409, "shell sessions are currently only supported for KUBERNETES_JOB environments");
  }

  let projectId: string | null = null;
  let namespace = GLOBAL_SECRET_NAMESPACE;
  if (input.data.mode === "project") {
    if (!input.data.projectId) {
      return sendError(res, 400, "projectId is required for project shell mode");
    }
    const project = await prisma.project.findUnique({
      where: { id: input.data.projectId },
      select: { id: true, namespace: true }
    });
    if (!project) {
      return sendError(res, 404, "project not found");
    }
    projectId = project.id;
    namespace = project.namespace;
  }

  const injectSecrets = input.data.injectSecrets ?? true;
  let podName = "";
  const sessionId = randomUUID();

  try {
    await ensureNamespace(namespace);
    const providerEnv = await resolveShellSecretEnv({
      mode: input.data.mode,
      projectId: projectId ?? undefined,
      injectSecrets
    });
    const resources = normalizeEnvironmentResources(environment.resourcesJson);
    podName = `env-shell-${sessionId.replace(/[^a-z0-9-]+/gi, "").toLowerCase()}`.slice(0, 63);
    await kube.createNamespacedPod({
      namespace,
      body: {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: podName,
          namespace,
          labels: {
            "app.kubernetes.io/name": "factory-env-shell",
            "attractor.shell/session-id": sessionId
          }
        },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: environment.serviceAccountName ?? RUNNER_DEFAULT_SERVICE_ACCOUNT,
          containers: [
            {
              name: "shell",
              image: environment.runnerImage,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "-lc", "while true; do sleep 3600; done"],
              stdin: true,
              tty: true,
              env: providerEnv,
              ...(resources ? { resources } : {})
            }
          ]
        }
      } as never
    });
    await waitForPodRunning({
      kube,
      namespace,
      podName,
      timeoutMs: SHELL_POD_READY_TIMEOUT_SECONDS * 1000
    });
  } catch (error) {
    if (podName) {
      await deleteShellPod(namespace, podName);
    }
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }

  const ttlTimer = setTimeout(() => {
    void terminateEnvironmentShellSession(sessionId);
  }, SHELL_SESSION_TTL_SECONDS * 1000);
  environmentShellSessions.set(sessionId, {
    id: sessionId,
    environmentId: environment.id,
    mode: input.data.mode,
    projectId,
    namespace,
    podName,
    injectSecrets,
    connected: false,
    ttlTimer
  });

  res.status(201).json({
    session: {
      id: sessionId,
      environmentId: environment.id,
      mode: input.data.mode,
      projectId,
      namespace,
      podName,
      injectSecrets,
      expiresAt: new Date(Date.now() + SHELL_SESSION_TTL_SECONDS * 1000).toISOString(),
      streamPath: `/api/environments/shell/sessions/${sessionId}/stream`
    }
  });
});

app.delete("/api/environments/shell/sessions/:sessionId", async (req, res) => {
  await terminateEnvironmentShellSession(req.params.sessionId);
  res.status(204).send();
});

const createProjectSchema = z.object({
  name: z.string().min(2).max(80),
  namespace: z.string().min(2).max(63).optional(),
  defaultEnvironmentId: z.string().min(1).optional()
});

async function createProjectRecord(input: {
  name: string;
  namespace?: string;
  defaultEnvironmentId?: string;
}) {
  const namespace = input.namespace ?? toProjectNamespace(input.name);
  const defaultEnvironment = input.defaultEnvironmentId
    ? await prisma.environment.findUnique({
        where: { id: input.defaultEnvironmentId }
      })
    : await ensureDefaultEnvironment();
  if (!defaultEnvironment) {
    throw new Error("default environment not found");
  }
  if (!defaultEnvironment.active) {
    throw new Error(`environment ${defaultEnvironment.name} is inactive`);
  }
  await ensureNamespace(namespace);
  const project = await prisma.project.create({
    data: {
      name: input.name,
      namespace,
      defaultEnvironmentId: defaultEnvironment.id
    }
  });
  await syncGlobalSecretsToNamespace(namespace);
  await syncGlobalAttractorsToProject(project.id);
  await syncGlobalTaskTemplatesToProject(project.id);
  return project;
}

app.post("/api/projects", async (req, res) => {
  const input = createProjectSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  let project;
  try {
    project = await createProjectRecord(input.data);
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  res.status(201).json(project);
});

app.get("/api/projects", async (_req, res) => {
  const projects = await prisma.project.findMany({ orderBy: { createdAt: "desc" } });
  res.json({ projects });
});

const projectDefaultEnvironmentSchema = z.object({
  environmentId: z.string().min(1)
});

app.post("/api/projects/:projectId/environment", async (req, res) => {
  const input = projectDefaultEnvironmentSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (!project) {
    return sendError(res, 404, "project not found");
  }

  const environment = await prisma.environment.findUnique({
    where: { id: input.data.environmentId }
  });
  if (!environment) {
    return sendError(res, 404, "environment not found");
  }
  if (!environment.active) {
    return sendError(res, 409, `environment ${environment.name} is inactive`);
  }

  const updatedProject = await prisma.project.update({
    where: { id: project.id },
    data: { defaultEnvironmentId: environment.id }
  });

  res.json(updatedProject);
});

const patchProjectRedeployDefaultsSchema = z
  .object({
    redeployAttractorId: z.string().min(1).nullable().optional(),
    redeploySourceBranch: z.string().min(1).nullable().optional(),
    redeployTargetBranch: z.string().min(1).nullable().optional(),
    redeployEnvironmentId: z.string().min(1).nullable().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field is required"
  });

app.patch("/api/projects/:projectId/redeploy-defaults", async (req, res) => {
  const input = patchProjectRedeployDefaultsSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  const project = await prisma.project.findUnique({
    where: { id: req.params.projectId }
  });
  if (!project) {
    return sendError(res, 404, "project not found");
  }

  if (input.data.redeployAttractorId !== undefined && input.data.redeployAttractorId !== null) {
    const attractor = await prisma.attractorDef.findUnique({
      where: { id: input.data.redeployAttractorId }
    });
    if (!attractor || attractor.projectId !== project.id) {
      return sendError(res, 404, "redeploy attractor not found in project");
    }
    if (!attractor.active) {
      return sendError(res, 409, "redeploy attractor is inactive");
    }
  }

  if (input.data.redeployEnvironmentId !== undefined && input.data.redeployEnvironmentId !== null) {
    const environment = await prisma.environment.findUnique({
      where: { id: input.data.redeployEnvironmentId }
    });
    if (!environment) {
      return sendError(res, 404, "redeploy environment not found");
    }
    if (!environment.active) {
      return sendError(res, 409, `environment ${environment.name} is inactive`);
    }
  }

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: {
      ...(input.data.redeployAttractorId !== undefined
        ? { redeployAttractorId: input.data.redeployAttractorId }
        : {}),
      ...(input.data.redeploySourceBranch !== undefined
        ? { redeploySourceBranch: toNullableText(input.data.redeploySourceBranch ?? undefined) }
        : {}),
      ...(input.data.redeployTargetBranch !== undefined
        ? { redeployTargetBranch: toNullableText(input.data.redeployTargetBranch ?? undefined) }
        : {}),
      ...(input.data.redeployEnvironmentId !== undefined
        ? { redeployEnvironmentId: input.data.redeployEnvironmentId }
        : {})
    }
  });

  res.json(updated);
});

const bootstrapSelfSchema = z.object({
  name: z.string().min(2).max(80).default("attractor-self"),
  namespace: z.string().min(2).max(63).optional(),
  defaultEnvironmentId: z.string().min(1).optional(),
  repoFullName: z.string().min(3),
  defaultBranch: z.string().min(1).default("main"),
  installationId: z.string().min(1).optional(),
  attractorName: z.string().min(1).default("self-factory"),
  attractorPath: z.string().min(1).default("factory/self-bootstrap.dot"),
  attractorContent: z.string().min(1).optional(),
  modelConfig: runModelConfigSchema.default({
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    reasoningLevel: "high",
    temperature: 0.2
  })
});

app.post("/api/bootstrap/self", async (req, res) => {
  const input = bootstrapSelfSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }
  try {
    normalizeRunModelConfig(input.data.modelConfig);
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  const namespace = input.data.namespace ?? toProjectNamespace(input.data.name);
  await ensureNamespace(namespace);

  let explicitEnvironmentId: string | undefined;
  if (input.data.defaultEnvironmentId) {
    const explicitEnvironment = await prisma.environment.findUnique({
      where: { id: input.data.defaultEnvironmentId }
    });
    if (!explicitEnvironment) {
      return sendError(res, 404, "default environment not found");
    }
    if (!explicitEnvironment.active) {
      return sendError(res, 409, `environment ${explicitEnvironment.name} is inactive`);
    }
    explicitEnvironmentId = explicitEnvironment.id;
  } else {
    explicitEnvironmentId = (await ensureDefaultEnvironment()).id;
  }

  const project = await prisma.project.upsert({
    where: { namespace },
    update: {
      name: input.data.name,
      repoFullName: input.data.repoFullName,
      defaultBranch: input.data.defaultBranch,
      ...(input.data.defaultEnvironmentId ? { defaultEnvironmentId: explicitEnvironmentId } : {}),
      ...(input.data.installationId ? { githubInstallationId: input.data.installationId } : {})
    },
    create: {
      name: input.data.name,
      namespace,
      repoFullName: input.data.repoFullName,
      defaultBranch: input.data.defaultBranch,
      defaultEnvironmentId: explicitEnvironmentId,
      ...(input.data.installationId ? { githubInstallationId: input.data.installationId } : {})
    }
  });

  let effectiveProject = project;
  if (!project.defaultEnvironmentId) {
    effectiveProject = await prisma.project.update({
      where: { id: project.id },
      data: { defaultEnvironmentId: explicitEnvironmentId }
    });
  }

  await syncGlobalSecretsToNamespace(namespace);
  await syncGlobalAttractorsToProject(effectiveProject.id);
  await syncGlobalTaskTemplatesToProject(effectiveProject.id);

  let bootstrapAttractorContent = toNullableText(input.data.attractorContent);
  if (!bootstrapAttractorContent) {
    const absolutePath = join(process.cwd(), input.data.attractorPath);
    try {
      bootstrapAttractorContent = readFileSync(absolutePath, "utf8");
    } catch (error) {
      return sendError(
        res,
        400,
        `unable to load bootstrap attractor content from ${input.data.attractorPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  const bootstrapParsed = parseAndLintAttractorContent(bootstrapAttractorContent);
  if (!bootstrapParsed.validation.valid) {
    const message = bootstrapParsed.validation.diagnostics
      .filter((item) => item.severity === "ERROR")
      .map((item) => item.message)
      .join("; ");
    return sendError(res, 400, `bootstrap attractor content failed validation: ${message}`);
  }
  bootstrapAttractorContent = bootstrapParsed.content;

  const existingBootstrapAttractor = await prisma.attractorDef.findUnique({
    where: {
      projectId_name_scope: {
        projectId: effectiveProject.id,
        name: input.data.attractorName,
        scope: AttractorScope.PROJECT
      }
    }
  });
  const currentVersion = existingBootstrapAttractor?.contentVersion ?? 0;
  const latestVersion =
    existingBootstrapAttractor && currentVersion > 0
      ? await prisma.attractorDefVersion.findUnique({
          where: {
            attractorDefId_version: {
              attractorDefId: existingBootstrapAttractor.id,
              version: currentVersion
            }
          }
        })
      : null;
  const contentSha256 = digestText(bootstrapAttractorContent);
  const needsNewVersion =
    !existingBootstrapAttractor ||
    !existingBootstrapAttractor.contentPath ||
    currentVersion <= 0 ||
    latestVersion?.contentSha256 !== contentSha256;

  let contentPath = existingBootstrapAttractor?.contentPath ?? null;
  let contentVersion = currentVersion;
  if (needsNewVersion) {
    contentVersion = Math.max(currentVersion, 0) + 1;
    contentPath = attractorObjectPath({
      scope: "project",
      projectId: effectiveProject.id,
      name: input.data.attractorName,
      version: contentVersion
    });
    await putAttractorContent(contentPath, bootstrapAttractorContent);
  }

  const attractor = await prisma.attractorDef.upsert({
    where: {
      projectId_name_scope: {
        projectId: effectiveProject.id,
        name: input.data.attractorName,
        scope: AttractorScope.PROJECT
      }
    },
    update: {
      repoPath: input.data.attractorPath,
      contentPath,
      contentVersion,
      defaultRunType: "planning",
      modelConfig: input.data.modelConfig as never,
      active: true,
      description: "Self-bootstrap attractor pipeline for this repository"
    },
    create: {
      projectId: effectiveProject.id,
      scope: AttractorScope.PROJECT,
      name: input.data.attractorName,
      repoPath: input.data.attractorPath,
      contentPath,
      contentVersion,
      defaultRunType: "planning",
      modelConfig: input.data.modelConfig as never,
      active: true,
      description: "Self-bootstrap attractor pipeline for this repository"
    }
  });

  if (needsNewVersion && contentPath) {
    await prisma.attractorDefVersion.create({
      data: {
        attractorDefId: attractor.id,
        version: contentVersion,
        contentPath,
        contentSha256,
        sizeBytes: Buffer.byteLength(bootstrapAttractorContent, "utf8")
      }
    });
  }

  res.status(201).json({ project: effectiveProject, attractor });
});

const githubConnectSchema = z.object({
  installationId: z.string().min(1),
  repoFullName: z.string().min(3),
  defaultBranch: z.string().min(1)
});

app.post("/api/projects/:projectId/repo/connect/github", async (req, res) => {
  const input = githubConnectSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  const project = await prisma.project.update({
    where: { id: req.params.projectId },
    data: {
      githubInstallationId: input.data.installationId,
      repoFullName: input.data.repoFullName,
      defaultBranch: input.data.defaultBranch
    }
  });

  res.json(project);
});

const ARBITRARY_SECRET_PROVIDER = "__arbitrary__";

function normalizeSecretProvider(provider: string | undefined): string {
  const normalized = (provider ?? "").trim();
  return normalized.length > 0 ? normalized : ARBITRARY_SECRET_PROVIDER;
}

function normalizeSecretPayload(input: {
  provider?: string;
  keyMappings: Record<string, string>;
  values: Record<string, string>;
}): { provider: string; keyMappings: Record<string, string>; values: Record<string, string> } {
  const provider = normalizeSecretProvider(input.provider);
  const values = input.values;
  const keyMappings =
    Object.keys(input.keyMappings).length > 0
      ? input.keyMappings
      : Object.fromEntries(Object.keys(values).map((key) => [key, key]));
  return { provider, keyMappings, values };
}

const createSecretSchema = z.object({
  name: z.string().min(1),
  provider: z.string().optional(),
  k8sSecretName: z.string().min(1).optional(),
  keyMappings: z.record(z.string(), z.string()).default({}),
  values: z.record(z.string(), z.string()).refine((values) => Object.keys(values).length > 0, {
    message: "values must include at least one key"
  })
});

app.post("/api/secrets/global", async (req, res) => {
  const input = createSecretSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  const normalized = normalizeSecretPayload(input.data);
  const secretName = input.data.k8sSecretName ?? toSecretName("factory-global", input.data.name);
  const mappedSecretKeys = new Set(Object.values(normalized.keyMappings));
  const missingSecretValues = [...mappedSecretKeys].filter((secretKey) => !(secretKey in normalized.values));
  if (missingSecretValues.length > 0) {
    return sendError(
      res,
      400,
      `Secret values missing keys referenced by keyMappings: ${missingSecretValues.join(", ")}`
    );
  }

  if (getProviderSecretSchema(normalized.provider)) {
    try {
      materializeProviderSecretEnv({
        provider: normalized.provider,
        secretName,
        keys: normalized.keyMappings
      });
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
  }

  await upsertSecret(GLOBAL_SECRET_NAMESPACE, secretName, normalized.values);
  await propagateGlobalSecretToAllProjects(secretName, normalized.values);

  const saved = await prisma.globalSecret.upsert({
    where: {
      name: input.data.name
    },
    update: {
      provider: normalized.provider,
      k8sSecretName: secretName,
      keyMappings: normalized.keyMappings
    },
    create: {
      name: input.data.name,
      provider: normalized.provider,
      k8sSecretName: secretName,
      keyMappings: normalized.keyMappings
    }
  });

  res.status(201).json(saved);
});

app.get("/api/secrets/global", async (_req, res) => {
  const secrets = await prisma.globalSecret.findMany({
    orderBy: { createdAt: "desc" }
  });
  res.json({ secrets });
});

app.get("/api/secrets/global/:secretId/values", async (req, res) => {
  const secret = await prisma.globalSecret.findUnique({
    where: { id: req.params.secretId }
  });
  if (!secret) {
    return sendError(res, 404, "global secret not found");
  }

  try {
    const values = await readSecretValues(GLOBAL_SECRET_NAMESPACE, secret.k8sSecretName);
    return res.json({ values });
  } catch (error) {
    return sendError(res, 404, error instanceof Error ? error.message : String(error));
  }
});

app.post("/api/projects/:projectId/secrets", async (req, res) => {
  const input = createSecretSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (!project) {
    return sendError(res, 404, "project not found");
  }

  const normalized = normalizeSecretPayload(input.data);
  const secretName = input.data.k8sSecretName ?? toSecretName("factory-secret", input.data.name);

  const mappedSecretKeys = new Set(Object.values(normalized.keyMappings));
  const missingSecretValues = [...mappedSecretKeys].filter((secretKey) => !(secretKey in normalized.values));
  if (missingSecretValues.length > 0) {
    return sendError(
      res,
      400,
      `Secret values missing keys referenced by keyMappings: ${missingSecretValues.join(", ")}`
    );
  }

  if (getProviderSecretSchema(normalized.provider)) {
    try {
      materializeProviderSecretEnv({
        provider: normalized.provider,
        secretName,
        keys: normalized.keyMappings
      });
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
  }

  await upsertSecret(project.namespace, secretName, normalized.values);

  const saved = await prisma.projectSecret.upsert({
    where: {
      projectId_name: {
        projectId: project.id,
        name: input.data.name
      }
    },
    update: {
      provider: normalized.provider,
      k8sSecretName: secretName,
      keyMappings: normalized.keyMappings
    },
    create: {
      projectId: project.id,
      name: input.data.name,
      provider: normalized.provider,
      k8sSecretName: secretName,
      keyMappings: normalized.keyMappings
    }
  });

  res.status(201).json(saved);
});

app.get("/api/projects/:projectId/secrets", async (req, res) => {
  const secrets = await prisma.projectSecret.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { createdAt: "desc" }
  });
  res.json({ secrets });
});

app.get("/api/projects/:projectId/secrets/:secretId/values", async (req, res) => {
  const secret = await prisma.projectSecret.findFirst({
    where: {
      id: req.params.secretId,
      projectId: req.params.projectId
    },
    include: {
      project: {
        select: {
          namespace: true
        }
      }
    }
  });
  if (!secret) {
    return sendError(res, 404, "project secret not found");
  }

  try {
    const values = await readSecretValues(secret.project.namespace, secret.k8sSecretName);
    return res.json({ values });
  } catch (error) {
    return sendError(res, 404, error instanceof Error ? error.message : String(error));
  }
});

const createAttractorSchema = z.object({
  name: z.string().min(1),
  content: z.string().min(1),
  repoPath: z.string().optional(),
  defaultRunType: z.enum(["planning", "implementation", "task"]),
  modelConfig: runModelConfigSchema,
  description: z.string().optional(),
  active: z.boolean().optional()
});

const patchAttractorSchema = z
  .object({
    name: z.string().min(1).optional(),
    content: z.string().optional(),
    repoPath: z.string().nullable().optional(),
    defaultRunType: z.enum(["planning", "implementation", "task"]).optional(),
    modelConfig: runModelConfigSchema.nullable().optional(),
    description: z.string().nullable().optional(),
    active: z.boolean().optional(),
    expectedContentVersion: z.number().int().nonnegative().optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: "at least one field is required" });

async function buildAttractorContentPayload(contentPath: string | null): Promise<{
  content: string | null;
  validation: AttractorValidationPayload;
}> {
  if (!contentPath) {
    return {
      content: null,
      validation: {
        valid: false,
        errorCount: 1,
        warningCount: 0,
        diagnostics: [
          {
            rule: "legacy_content_source",
            severity: "ERROR",
            message: "Attractor has no storage-backed content (legacy repoPath only)."
          }
        ]
      }
    };
  }

  const stored = await loadAttractorContentFromStorage(contentPath);
  if (!stored) {
    return {
      content: null,
      validation: {
        valid: false,
        errorCount: 1,
        warningCount: 0,
        diagnostics: [
          {
            rule: "storage_content_missing",
            severity: "ERROR",
            message: `Attractor content missing at storage path ${contentPath}`
          }
        ]
      }
    };
  }

  const parsed = parseAndLintAttractorContent(stored);
  return {
    content: parsed.content,
    validation: parsed.validation
  };
}

app.post("/api/attractors/global", async (req, res) => {
  const input = createAttractorSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }
  try {
    normalizeRunModelConfig(input.data.modelConfig);
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  const parsed = parseAndLintAttractorContent(input.data.content);
  if (!parsed.validation.valid) {
    return res.status(400).json({
      error: "attractor content failed validation",
      validation: parsed.validation
    });
  }
  const content = parsed.content;

  const existing = await prisma.globalAttractor.findUnique({
    where: { name: input.data.name }
  });
  const currentVersion = existing?.contentVersion ?? 0;
  const latestVersion =
    existing && currentVersion > 0
      ? await prisma.globalAttractorVersion.findUnique({
          where: {
            globalAttractorId_version: {
              globalAttractorId: existing.id,
              version: currentVersion
            }
          }
        })
      : null;
  const contentSha256 = digestText(content);
  const needsNewVersion =
    !existing || !existing.contentPath || currentVersion <= 0 || latestVersion?.contentSha256 !== contentSha256;

  let contentPath = existing?.contentPath ?? null;
  let contentVersion = currentVersion;
  if (needsNewVersion) {
    contentVersion = Math.max(currentVersion, 0) + 1;
    contentPath = attractorObjectPath({
      scope: "global",
      name: input.data.name,
      version: contentVersion
    });
    await putAttractorContent(contentPath, content);
  }

  const saved = await prisma.globalAttractor.upsert({
    where: {
      name: input.data.name
    },
    update: {
      repoPath: toNullableText(input.data.repoPath),
      contentPath,
      contentVersion,
      defaultRunType: input.data.defaultRunType,
      modelConfig: input.data.modelConfig as never,
      description: input.data.description,
      ...(input.data.active !== undefined ? { active: input.data.active } : {})
    },
    create: {
      name: input.data.name,
      repoPath: toNullableText(input.data.repoPath),
      contentPath,
      contentVersion,
      defaultRunType: input.data.defaultRunType,
      modelConfig: input.data.modelConfig as never,
      description: input.data.description,
      active: input.data.active ?? true
    }
  });

  if (needsNewVersion && contentPath) {
    await prisma.globalAttractorVersion.create({
      data: {
        globalAttractorId: saved.id,
        version: contentVersion,
        contentPath,
        contentSha256,
        sizeBytes: Buffer.byteLength(content, "utf8")
      }
    });
  }

  await propagateGlobalAttractorToAllProjects(saved);

  res.status(201).json(saved);
});

app.get("/api/attractors/global", async (_req, res) => {
  const attractors = await prisma.globalAttractor.findMany({
    orderBy: { createdAt: "desc" }
  });
  res.json({ attractors });
});

app.get("/api/attractors/global/:attractorId", async (req, res) => {
  const attractor = await prisma.globalAttractor.findUnique({
    where: { id: req.params.attractorId }
  });
  if (!attractor) {
    return sendError(res, 404, "global attractor not found");
  }

  const payload = await buildAttractorContentPayload(attractor.contentPath);
  res.json({
    attractor,
    content: payload.content,
    validation: payload.validation
  });
});

app.get("/api/attractors/global/:attractorId/versions", async (req, res) => {
  const attractor = await prisma.globalAttractor.findUnique({
    where: { id: req.params.attractorId },
    select: { id: true }
  });
  if (!attractor) {
    return sendError(res, 404, "global attractor not found");
  }

  const versions = await prisma.globalAttractorVersion.findMany({
    where: { globalAttractorId: attractor.id },
    orderBy: { version: "desc" }
  });
  res.json({ versions });
});

app.get("/api/attractors/global/:attractorId/versions/:version", async (req, res) => {
  const version = Number.parseInt(req.params.version, 10);
  if (!Number.isInteger(version) || version <= 0) {
    return sendError(res, 400, "version must be a positive integer");
  }

  const attractor = await prisma.globalAttractor.findUnique({
    where: { id: req.params.attractorId },
    select: { id: true }
  });
  if (!attractor) {
    return sendError(res, 404, "global attractor not found");
  }

  const versionRow = await prisma.globalAttractorVersion.findUnique({
    where: {
      globalAttractorId_version: {
        globalAttractorId: attractor.id,
        version
      }
    }
  });
  if (!versionRow) {
    return sendError(res, 404, "global attractor version not found");
  }

  const payload = await buildAttractorContentPayload(versionRow.contentPath);
  res.json({
    version: versionRow,
    content: payload.content,
    validation: payload.validation
  });
});

app.patch("/api/attractors/global/:attractorId", async (req, res) => {
  const input = patchAttractorSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }
  if (input.data.modelConfig !== undefined && input.data.modelConfig !== null) {
    try {
      normalizeRunModelConfig(input.data.modelConfig);
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
  }

  const current = await prisma.globalAttractor.findUnique({
    where: { id: req.params.attractorId }
  });
  if (!current) {
    return sendError(res, 404, "global attractor not found");
  }

  if (
    input.data.expectedContentVersion !== undefined &&
    current.contentVersion !== input.data.expectedContentVersion
  ) {
    return sendError(
      res,
      409,
      `content version mismatch: expected ${input.data.expectedContentVersion}, current ${current.contentVersion}`
    );
  }

  let nextContentPath = current.contentPath;
  let nextContentVersion = current.contentVersion;
  let parsedContent: string | null = null;
  let parsedValidation: AttractorValidationPayload | null = null;

  if (input.data.content !== undefined) {
    const parsed = parseAndLintAttractorContent(input.data.content);
    parsedContent = parsed.content;
    parsedValidation = parsed.validation;
    if (!parsed.validation.valid) {
      return res.status(400).json({
        error: "attractor content failed validation",
        validation: parsed.validation
      });
    }

    const latestVersion =
      current.contentVersion > 0
        ? await prisma.globalAttractorVersion.findUnique({
            where: {
              globalAttractorId_version: {
                globalAttractorId: current.id,
                version: current.contentVersion
              }
            }
          })
        : null;
    const contentSha256 = digestText(parsed.content);
    const needsNewVersion =
      !current.contentPath ||
      current.contentVersion <= 0 ||
      !latestVersion ||
      latestVersion.contentSha256 !== contentSha256;

    if (needsNewVersion) {
      nextContentVersion = Math.max(current.contentVersion, 0) + 1;
      nextContentPath = attractorObjectPath({
        scope: "global",
        name: input.data.name ?? current.name,
        version: nextContentVersion
      });
      await putAttractorContent(nextContentPath, parsed.content);
      await prisma.globalAttractorVersion.create({
        data: {
          globalAttractorId: current.id,
          version: nextContentVersion,
          contentPath: nextContentPath,
          contentSha256,
          sizeBytes: Buffer.byteLength(parsed.content, "utf8")
        }
      });
    }
  }

  let updated;
  try {
    updated = await prisma.globalAttractor.update({
      where: { id: current.id },
      data: {
        ...(input.data.name !== undefined ? { name: input.data.name } : {}),
        ...(input.data.repoPath !== undefined ? { repoPath: toNullableText(input.data.repoPath ?? undefined) } : {}),
        ...(input.data.defaultRunType !== undefined ? { defaultRunType: input.data.defaultRunType } : {}),
        ...(input.data.modelConfig !== undefined ? { modelConfig: input.data.modelConfig as never } : {}),
        ...(input.data.description !== undefined ? { description: toNullableText(input.data.description ?? undefined) } : {}),
        ...(input.data.active !== undefined ? { active: input.data.active } : {}),
        ...(input.data.content !== undefined
          ? {
              contentPath: nextContentPath,
              contentVersion: nextContentVersion
            }
          : {})
      }
    });
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }

  await propagateGlobalAttractorToAllProjects(updated);

  const payload =
    parsedValidation && parsedContent
      ? { content: parsedContent, validation: parsedValidation }
      : await buildAttractorContentPayload(updated.contentPath);
  res.json({
    attractor: updated,
    content: payload.content,
    validation: payload.validation
  });
});

app.post("/api/projects/:projectId/attractors", async (req, res) => {
  const input = createAttractorSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }
  try {
    normalizeRunModelConfig(input.data.modelConfig);
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  const parsed = parseAndLintAttractorContent(input.data.content);
  if (!parsed.validation.valid) {
    return res.status(400).json({
      error: "attractor content failed validation",
      validation: parsed.validation
    });
  }
  const content = parsed.content;

  const existing = await prisma.attractorDef.findUnique({
    where: {
      projectId_name_scope: {
        projectId: req.params.projectId,
        name: input.data.name,
        scope: AttractorScope.PROJECT
      }
    }
  });
  const currentVersion = existing?.contentVersion ?? 0;
  const latestVersion =
    existing && currentVersion > 0
      ? await prisma.attractorDefVersion.findUnique({
          where: {
            attractorDefId_version: {
              attractorDefId: existing.id,
              version: currentVersion
            }
          }
        })
      : null;
  const contentSha256 = digestText(content);
  const needsNewVersion =
    !existing || !existing.contentPath || currentVersion <= 0 || latestVersion?.contentSha256 !== contentSha256;

  let contentPath = existing?.contentPath ?? null;
  let contentVersion = currentVersion;
  if (needsNewVersion) {
    contentVersion = Math.max(currentVersion, 0) + 1;
    contentPath = attractorObjectPath({
      scope: "project",
      projectId: req.params.projectId,
      name: input.data.name,
      version: contentVersion
    });
    await putAttractorContent(contentPath, content);
  }

  const saved = await prisma.attractorDef.upsert({
    where: {
      projectId_name_scope: {
        projectId: req.params.projectId,
        name: input.data.name,
        scope: AttractorScope.PROJECT
      }
    },
    update: {
      repoPath: toNullableText(input.data.repoPath),
      contentPath,
      contentVersion,
      defaultRunType: input.data.defaultRunType,
      modelConfig: input.data.modelConfig as never,
      description: input.data.description,
      ...(input.data.active !== undefined ? { active: input.data.active } : {})
    },
    create: {
      projectId: req.params.projectId,
      scope: AttractorScope.PROJECT,
      name: input.data.name,
      repoPath: toNullableText(input.data.repoPath),
      contentPath,
      contentVersion,
      defaultRunType: input.data.defaultRunType,
      modelConfig: input.data.modelConfig as never,
      description: input.data.description,
      active: input.data.active ?? true
    }
  });

  if (needsNewVersion && contentPath) {
    await prisma.attractorDefVersion.create({
      data: {
        attractorDefId: saved.id,
        version: contentVersion,
        contentPath,
        contentSha256,
        sizeBytes: Buffer.byteLength(content, "utf8")
      }
    });
  }

  res.status(201).json(saved);
});

app.get("/api/projects/:projectId/attractors", async (req, res) => {
  const attractors = await prisma.attractorDef.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { createdAt: "desc" }
  });
  res.json({ attractors });
});

app.get("/api/projects/:projectId/attractors/:attractorId", async (req, res) => {
  const attractor = await prisma.attractorDef.findFirst({
    where: {
      id: req.params.attractorId,
      projectId: req.params.projectId
    }
  });
  if (!attractor) {
    return sendError(res, 404, "attractor not found in project");
  }

  const payload = await buildAttractorContentPayload(attractor.contentPath);
  res.json({
    attractor,
    content: payload.content,
    validation: payload.validation
  });
});

app.get("/api/projects/:projectId/attractors/:attractorId/versions", async (req, res) => {
  const attractor = await prisma.attractorDef.findFirst({
    where: {
      id: req.params.attractorId,
      projectId: req.params.projectId
    },
    select: {
      id: true,
      scope: true,
      name: true
    }
  });
  if (!attractor) {
    return sendError(res, 404, "attractor not found in project");
  }

  if (attractor.scope === AttractorScope.GLOBAL) {
    const global = await prisma.globalAttractor.findUnique({
      where: { name: attractor.name },
      select: { id: true }
    });
    if (!global) {
      return sendError(res, 404, "global attractor backing record not found");
    }
    const versions = await prisma.globalAttractorVersion.findMany({
      where: { globalAttractorId: global.id },
      orderBy: { version: "desc" }
    });
    return res.json({ versions });
  }

  const versions = await prisma.attractorDefVersion.findMany({
    where: { attractorDefId: attractor.id },
    orderBy: { version: "desc" }
  });
  res.json({ versions });
});

app.get("/api/projects/:projectId/attractors/:attractorId/versions/:version", async (req, res) => {
  const version = Number.parseInt(req.params.version, 10);
  if (!Number.isInteger(version) || version <= 0) {
    return sendError(res, 400, "version must be a positive integer");
  }

  const attractor = await prisma.attractorDef.findFirst({
    where: {
      id: req.params.attractorId,
      projectId: req.params.projectId
    },
    select: {
      id: true,
      scope: true,
      name: true
    }
  });
  if (!attractor) {
    return sendError(res, 404, "attractor not found in project");
  }

  if (attractor.scope === AttractorScope.GLOBAL) {
    const global = await prisma.globalAttractor.findUnique({
      where: { name: attractor.name },
      select: { id: true }
    });
    if (!global) {
      return sendError(res, 404, "global attractor backing record not found");
    }
    const versionRow = await prisma.globalAttractorVersion.findUnique({
      where: {
        globalAttractorId_version: {
          globalAttractorId: global.id,
          version
        }
      }
    });
    if (!versionRow) {
      return sendError(res, 404, "attractor version not found");
    }
    const payload = await buildAttractorContentPayload(versionRow.contentPath);
    return res.json({
      version: versionRow,
      content: payload.content,
      validation: payload.validation
    });
  }

  const versionRow = await prisma.attractorDefVersion.findUnique({
    where: {
      attractorDefId_version: {
        attractorDefId: attractor.id,
        version
      }
    }
  });
  if (!versionRow) {
    return sendError(res, 404, "attractor version not found");
  }

  const payload = await buildAttractorContentPayload(versionRow.contentPath);
  res.json({
    version: versionRow,
    content: payload.content,
    validation: payload.validation
  });
});

app.patch("/api/projects/:projectId/attractors/:attractorId", async (req, res) => {
  const input = patchAttractorSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }
  if (input.data.modelConfig !== undefined && input.data.modelConfig !== null) {
    try {
      normalizeRunModelConfig(input.data.modelConfig);
    } catch (error) {
      return sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
  }

  const current = await prisma.attractorDef.findFirst({
    where: {
      id: req.params.attractorId,
      projectId: req.params.projectId
    }
  });
  if (!current) {
    return sendError(res, 404, "attractor not found in project");
  }
  if (current.scope !== AttractorScope.PROJECT) {
    return sendError(res, 409, "inherited global attractors are read-only in project scope");
  }

  if (
    input.data.expectedContentVersion !== undefined &&
    current.contentVersion !== input.data.expectedContentVersion
  ) {
    return sendError(
      res,
      409,
      `content version mismatch: expected ${input.data.expectedContentVersion}, current ${current.contentVersion}`
    );
  }

  let nextContentPath = current.contentPath;
  let nextContentVersion = current.contentVersion;
  let parsedContent: string | null = null;
  let parsedValidation: AttractorValidationPayload | null = null;

  if (input.data.content !== undefined) {
    const parsed = parseAndLintAttractorContent(input.data.content);
    parsedContent = parsed.content;
    parsedValidation = parsed.validation;
    if (!parsed.validation.valid) {
      return res.status(400).json({
        error: "attractor content failed validation",
        validation: parsed.validation
      });
    }

    const latestVersion =
      current.contentVersion > 0
        ? await prisma.attractorDefVersion.findUnique({
            where: {
              attractorDefId_version: {
                attractorDefId: current.id,
                version: current.contentVersion
              }
            }
          })
        : null;
    const contentSha256 = digestText(parsed.content);
    const needsNewVersion =
      !current.contentPath ||
      current.contentVersion <= 0 ||
      !latestVersion ||
      latestVersion.contentSha256 !== contentSha256;

    if (needsNewVersion) {
      nextContentVersion = Math.max(current.contentVersion, 0) + 1;
      nextContentPath = attractorObjectPath({
        scope: "project",
        projectId: req.params.projectId,
        name: input.data.name ?? current.name,
        version: nextContentVersion
      });
      await putAttractorContent(nextContentPath, parsed.content);
      await prisma.attractorDefVersion.create({
        data: {
          attractorDefId: current.id,
          version: nextContentVersion,
          contentPath: nextContentPath,
          contentSha256,
          sizeBytes: Buffer.byteLength(parsed.content, "utf8")
        }
      });
    }
  }

  let updated;
  try {
    updated = await prisma.attractorDef.update({
      where: { id: current.id },
      data: {
        ...(input.data.name !== undefined ? { name: input.data.name } : {}),
        ...(input.data.repoPath !== undefined ? { repoPath: toNullableText(input.data.repoPath ?? undefined) } : {}),
        ...(input.data.defaultRunType !== undefined ? { defaultRunType: input.data.defaultRunType } : {}),
        ...(input.data.modelConfig !== undefined ? { modelConfig: input.data.modelConfig as never } : {}),
        ...(input.data.description !== undefined ? { description: toNullableText(input.data.description ?? undefined) } : {}),
        ...(input.data.active !== undefined ? { active: input.data.active } : {}),
        ...(input.data.content !== undefined
          ? {
              contentPath: nextContentPath,
              contentVersion: nextContentVersion
            }
          : {})
      }
    });
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }

  const payload =
    parsedValidation && parsedContent
      ? { content: parsedContent, validation: parsedValidation }
      : await buildAttractorContentPayload(updated.contentPath);
  res.json({
    attractor: updated,
    content: payload.content,
    validation: payload.validation
  });
});

const createTaskTemplateSchema = z.object({
  name: z.string().min(1),
  attractorName: z.string().min(1),
  runType: z.enum(["planning", "implementation", "task"]),
  sourceBranch: z.string().optional(),
  targetBranch: z.string().optional(),
  environmentMode: z.enum(["PROJECT_DEFAULT", "NAMED"]).default("PROJECT_DEFAULT"),
  environmentName: z.string().nullable().optional(),
  scheduleEnabled: z.boolean().default(false),
  scheduleCron: z.string().nullable().optional(),
  scheduleTimezone: z.string().nullable().optional(),
  triggers: z.unknown().optional(),
  description: z.string().nullable().optional(),
  active: z.boolean().optional()
});

const patchTaskTemplateSchema = z
  .object({
    name: z.string().min(1).optional(),
    attractorName: z.string().min(1).optional(),
    runType: z.enum(["planning", "implementation", "task"]).optional(),
    sourceBranch: z.string().nullable().optional(),
    targetBranch: z.string().nullable().optional(),
    environmentMode: z.enum(["PROJECT_DEFAULT", "NAMED"]).optional(),
    environmentName: z.string().nullable().optional(),
    scheduleEnabled: z.boolean().optional(),
    scheduleCron: z.string().nullable().optional(),
    scheduleTimezone: z.string().nullable().optional(),
    triggers: z.unknown().optional(),
    description: z.string().nullable().optional(),
    active: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: "at least one field is required" });

function normalizeTemplateText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

app.post("/api/task-templates/global", async (req, res) => {
  const input = createTaskTemplateSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  let parsedRules: TaskTemplateTriggerRule[];
  try {
    parsedRules = parseTemplateTriggersOrThrow(input.data.triggers ?? []);
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  let schedule;
  try {
    schedule = normalizeTemplateScheduleInput({
      scheduleEnabled: input.data.scheduleEnabled,
      scheduleCron: normalizeTemplateText(input.data.scheduleCron),
      scheduleTimezone: normalizeTemplateText(input.data.scheduleTimezone)
    });
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  const saved = await prisma.globalTaskTemplate.upsert({
    where: { name: input.data.name },
    update: {
      attractorName: input.data.attractorName,
      runType: input.data.runType,
      sourceBranch: normalizeTemplateText(input.data.sourceBranch),
      targetBranch: normalizeTemplateText(input.data.targetBranch),
      environmentMode: input.data.environmentMode,
      environmentName: normalizeTemplateText(input.data.environmentName),
      scheduleEnabled: input.data.scheduleEnabled,
      scheduleCron: schedule.scheduleCron,
      scheduleTimezone: schedule.scheduleTimezone,
      triggersJson: parsedRules as never,
      description: normalizeTemplateText(input.data.description),
      ...(input.data.active !== undefined ? { active: input.data.active } : {})
    },
    create: {
      name: input.data.name,
      attractorName: input.data.attractorName,
      runType: input.data.runType,
      sourceBranch: normalizeTemplateText(input.data.sourceBranch),
      targetBranch: normalizeTemplateText(input.data.targetBranch),
      environmentMode: input.data.environmentMode,
      environmentName: normalizeTemplateText(input.data.environmentName),
      scheduleEnabled: input.data.scheduleEnabled,
      scheduleCron: schedule.scheduleCron,
      scheduleTimezone: schedule.scheduleTimezone,
      triggersJson: parsedRules as never,
      description: normalizeTemplateText(input.data.description),
      active: input.data.active ?? true
    }
  });

  await propagateGlobalTaskTemplateToAllProjects({
    name: saved.name,
    attractorName: saved.attractorName,
    runType: saved.runType,
    sourceBranch: saved.sourceBranch,
    targetBranch: saved.targetBranch,
    environmentMode: saved.environmentMode,
    environmentName: saved.environmentName,
    scheduleEnabled: saved.scheduleEnabled,
    scheduleCron: saved.scheduleCron,
    scheduleTimezone: saved.scheduleTimezone,
    triggersJson: saved.triggersJson,
    description: saved.description,
    active: saved.active
  });

  res.status(201).json(saved);
});

app.get("/api/task-templates/global", async (_req, res) => {
  const templates = await prisma.globalTaskTemplate.findMany({
    orderBy: { createdAt: "desc" }
  });
  res.json({ templates });
});

app.get("/api/task-templates/global/:templateId", async (req, res) => {
  const template = await prisma.globalTaskTemplate.findUnique({
    where: { id: req.params.templateId }
  });
  if (!template) {
    return sendError(res, 404, "global task template not found");
  }
  res.json({ template });
});

app.patch("/api/task-templates/global/:templateId", async (req, res) => {
  const input = patchTaskTemplateSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  const current = await prisma.globalTaskTemplate.findUnique({
    where: { id: req.params.templateId }
  });
  if (!current) {
    return sendError(res, 404, "global task template not found");
  }

  const mergedTriggers = input.data.triggers !== undefined ? input.data.triggers : current.triggersJson;
  let parsedRules: TaskTemplateTriggerRule[];
  try {
    parsedRules = parseTemplateTriggersOrThrow(mergedTriggers ?? []);
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  let schedule;
  try {
    schedule = normalizeTemplateScheduleInput({
      scheduleEnabled: input.data.scheduleEnabled ?? current.scheduleEnabled,
      scheduleCron:
        input.data.scheduleCron !== undefined
          ? normalizeTemplateText(input.data.scheduleCron)
          : current.scheduleCron,
      scheduleTimezone:
        input.data.scheduleTimezone !== undefined
          ? normalizeTemplateText(input.data.scheduleTimezone)
          : current.scheduleTimezone
    });
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  const updated = await prisma.globalTaskTemplate.update({
    where: { id: current.id },
    data: {
      ...(input.data.name !== undefined ? { name: input.data.name } : {}),
      ...(input.data.attractorName !== undefined ? { attractorName: input.data.attractorName } : {}),
      ...(input.data.runType !== undefined ? { runType: input.data.runType } : {}),
      ...(input.data.sourceBranch !== undefined
        ? { sourceBranch: normalizeTemplateText(input.data.sourceBranch) }
        : {}),
      ...(input.data.targetBranch !== undefined
        ? { targetBranch: normalizeTemplateText(input.data.targetBranch) }
        : {}),
      ...(input.data.environmentMode !== undefined
        ? { environmentMode: input.data.environmentMode }
        : {}),
      ...(input.data.environmentName !== undefined
        ? { environmentName: normalizeTemplateText(input.data.environmentName) }
        : {}),
      ...(input.data.scheduleEnabled !== undefined
        ? { scheduleEnabled: input.data.scheduleEnabled }
        : {}),
      ...(input.data.scheduleCron !== undefined || input.data.scheduleTimezone !== undefined || input.data.scheduleEnabled !== undefined
        ? {
            scheduleCron: schedule.scheduleCron,
            scheduleTimezone: schedule.scheduleTimezone
          }
        : {}),
      ...(input.data.triggers !== undefined ? { triggersJson: parsedRules as never } : {}),
      ...(input.data.description !== undefined
        ? { description: normalizeTemplateText(input.data.description) }
        : {}),
      ...(input.data.active !== undefined ? { active: input.data.active } : {})
    }
  });

  await propagateGlobalTaskTemplateToAllProjects({
    name: updated.name,
    attractorName: updated.attractorName,
    runType: updated.runType,
    sourceBranch: updated.sourceBranch,
    targetBranch: updated.targetBranch,
    environmentMode: updated.environmentMode,
    environmentName: updated.environmentName,
    scheduleEnabled: updated.scheduleEnabled,
    scheduleCron: updated.scheduleCron,
    scheduleTimezone: updated.scheduleTimezone,
    triggersJson: updated.triggersJson,
    description: updated.description,
    active: updated.active
  });

  res.json({ template: updated });
});

app.post("/api/projects/:projectId/task-templates", async (req, res) => {
  const input = createTaskTemplateSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (!project) {
    return sendError(res, 404, "project not found");
  }

  let parsedRules: TaskTemplateTriggerRule[];
  try {
    parsedRules = parseTemplateTriggersOrThrow(input.data.triggers ?? []);
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  let schedule;
  try {
    schedule = normalizeTemplateScheduleInput({
      scheduleEnabled: input.data.scheduleEnabled,
      scheduleCron: normalizeTemplateText(input.data.scheduleCron),
      scheduleTimezone: normalizeTemplateText(input.data.scheduleTimezone)
    });
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  const template = await prisma.taskTemplate.upsert({
    where: {
      projectId_name_scope: {
        projectId: project.id,
        name: input.data.name,
        scope: AttractorScope.PROJECT
      }
    },
    update: {
      attractorName: input.data.attractorName,
      runType: input.data.runType,
      sourceBranch: normalizeTemplateText(input.data.sourceBranch),
      targetBranch: normalizeTemplateText(input.data.targetBranch),
      environmentMode: input.data.environmentMode,
      environmentName: normalizeTemplateText(input.data.environmentName),
      scheduleEnabled: input.data.scheduleEnabled,
      scheduleCron: schedule.scheduleCron,
      scheduleTimezone: schedule.scheduleTimezone,
      scheduleNextRunAt: schedule.scheduleNextRunAt,
      scheduleLastError: null,
      triggersJson: parsedRules as never,
      description: normalizeTemplateText(input.data.description),
      ...(input.data.active !== undefined ? { active: input.data.active } : {})
    },
    create: {
      projectId: project.id,
      scope: AttractorScope.PROJECT,
      name: input.data.name,
      attractorName: input.data.attractorName,
      runType: input.data.runType,
      sourceBranch: normalizeTemplateText(input.data.sourceBranch),
      targetBranch: normalizeTemplateText(input.data.targetBranch),
      environmentMode: input.data.environmentMode,
      environmentName: normalizeTemplateText(input.data.environmentName),
      scheduleEnabled: input.data.scheduleEnabled,
      scheduleCron: schedule.scheduleCron,
      scheduleTimezone: schedule.scheduleTimezone,
      scheduleNextRunAt: schedule.scheduleNextRunAt,
      triggersJson: parsedRules as never,
      description: normalizeTemplateText(input.data.description),
      active: input.data.active ?? true
    }
  });

  res.status(201).json({ template });
});

app.get("/api/projects/:projectId/task-templates", async (req, res) => {
  const templates = await prisma.taskTemplate.findMany({
    where: { projectId: req.params.projectId },
    orderBy: [{ createdAt: "desc" }]
  });
  const rows = buildTaskTemplateRows(templates);
  const effectiveTemplates = selectEffectiveRowsByName(templates);
  res.json({ templates, rows, effectiveTemplates });
});

app.get("/api/projects/:projectId/task-templates/events", async (req, res) => {
  const events = await prisma.taskTemplateEventLedger.findMany({
    where: { projectId: req.params.projectId },
    include: {
      taskTemplate: {
        select: {
          id: true,
          name: true,
          scope: true
        }
      }
    },
    orderBy: { createdAt: "desc" },
    take: 200
  });
  res.json({ events });
});

app.post("/api/projects/:projectId/task-templates/events/:eventId/replay", async (req, res) => {
  const eventRecord = await prisma.taskTemplateEventLedger.findFirst({
    where: {
      id: req.params.eventId,
      projectId: req.params.projectId
    },
    include: {
      taskTemplate: true
    }
  });
  if (!eventRecord) {
    return sendError(res, 404, "task template event not found");
  }
  if (!eventRecord.taskTemplate.active) {
    return sendError(res, 409, "task template is inactive");
  }

  const payload = (eventRecord.payload ?? {}) as Record<string, unknown>;
  const triggerContext = (payload.triggerContext ?? null) as TaskTemplateTriggerContext | null;
  const githubIssueId =
    typeof payload.githubIssueId === "string" && payload.githubIssueId.trim().length > 0
      ? payload.githubIssueId
      : null;
  const githubPullRequestId =
    typeof payload.githubPullRequestId === "string" && payload.githubPullRequestId.trim().length > 0
      ? payload.githubPullRequestId
      : null;

  try {
    const queued = await queueRunFromTaskTemplate({
      projectId: eventRecord.projectId,
      taskTemplateId: eventRecord.taskTemplateId,
      taskTemplateName: eventRecord.taskTemplate.name,
      attractorName: eventRecord.taskTemplate.attractorName,
      runType: eventRecord.taskTemplate.runType,
      sourceBranch: eventRecord.taskTemplate.sourceBranch,
      targetBranch: eventRecord.taskTemplate.targetBranch,
      environmentMode: eventRecord.taskTemplate.environmentMode,
      environmentName: eventRecord.taskTemplate.environmentName,
      launchMode: TaskTemplateLaunchMode.REPLAY,
      githubIssueId,
      githubPullRequestId,
      triggerContext,
      matchedRuleIds: Array.isArray(eventRecord.matchedRuleIds)
        ? (eventRecord.matchedRuleIds as string[])
        : []
    });

    const replayDedupeKey = `${eventRecord.dedupeKey}:replay:${Date.now()}`;
    await prisma.taskTemplateEventLedger.create({
      data: {
        projectId: eventRecord.projectId,
        taskTemplateId: eventRecord.taskTemplateId,
        runId: queued.runId,
        eventName: eventRecord.eventName,
        eventAction: eventRecord.eventAction,
        dedupeKey: replayDedupeKey,
        deliveryId: eventRecord.deliveryId,
        entityType: eventRecord.entityType,
        entityNumber: eventRecord.entityNumber,
        matchedRuleIds: eventRecord.matchedRuleIds as never,
        payload: eventRecord.payload as never,
        status: "REPLAYED",
        reason: `replay of ${eventRecord.id}`,
        replayedAt: new Date()
      }
    });
    await prisma.taskTemplateEventLedger.update({
      where: { id: eventRecord.id },
      data: { replayedAt: new Date() }
    });

    return res.status(201).json({ runId: queued.runId, status: queued.status });
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

app.get("/api/projects/:projectId/task-templates/:templateId", async (req, res) => {
  const template = await prisma.taskTemplate.findFirst({
    where: {
      projectId: req.params.projectId,
      id: req.params.templateId
    }
  });
  if (!template) {
    return sendError(res, 404, "task template not found");
  }
  res.json({ template });
});

app.patch("/api/projects/:projectId/task-templates/:templateId", async (req, res) => {
  const input = patchTaskTemplateSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  const current = await prisma.taskTemplate.findFirst({
    where: {
      projectId: req.params.projectId,
      id: req.params.templateId
    }
  });
  if (!current) {
    return sendError(res, 404, "task template not found");
  }
  if (current.scope !== AttractorScope.PROJECT) {
    return sendError(res, 409, "inherited global task templates are read-only in project scope");
  }

  const mergedTriggers = input.data.triggers !== undefined ? input.data.triggers : current.triggersJson;
  let parsedRules: TaskTemplateTriggerRule[];
  try {
    parsedRules = parseTemplateTriggersOrThrow(mergedTriggers ?? []);
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  let schedule;
  try {
    schedule = normalizeTemplateScheduleInput({
      scheduleEnabled: input.data.scheduleEnabled ?? current.scheduleEnabled,
      scheduleCron:
        input.data.scheduleCron !== undefined
          ? normalizeTemplateText(input.data.scheduleCron)
          : current.scheduleCron,
      scheduleTimezone:
        input.data.scheduleTimezone !== undefined
          ? normalizeTemplateText(input.data.scheduleTimezone)
          : current.scheduleTimezone
    });
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }

  const template = await prisma.taskTemplate.update({
    where: { id: current.id },
    data: {
      ...(input.data.name !== undefined ? { name: input.data.name } : {}),
      ...(input.data.attractorName !== undefined ? { attractorName: input.data.attractorName } : {}),
      ...(input.data.runType !== undefined ? { runType: input.data.runType } : {}),
      ...(input.data.sourceBranch !== undefined
        ? { sourceBranch: normalizeTemplateText(input.data.sourceBranch) }
        : {}),
      ...(input.data.targetBranch !== undefined
        ? { targetBranch: normalizeTemplateText(input.data.targetBranch) }
        : {}),
      ...(input.data.environmentMode !== undefined
        ? { environmentMode: input.data.environmentMode }
        : {}),
      ...(input.data.environmentName !== undefined
        ? { environmentName: normalizeTemplateText(input.data.environmentName) }
        : {}),
      ...(input.data.scheduleEnabled !== undefined
        ? { scheduleEnabled: input.data.scheduleEnabled }
        : {}),
      ...(input.data.scheduleCron !== undefined || input.data.scheduleTimezone !== undefined || input.data.scheduleEnabled !== undefined
        ? {
            scheduleCron: schedule.scheduleCron,
            scheduleTimezone: schedule.scheduleTimezone,
            scheduleNextRunAt: schedule.scheduleNextRunAt
          }
        : {}),
      ...(input.data.triggers !== undefined ? { triggersJson: parsedRules as never } : {}),
      ...(input.data.description !== undefined
        ? { description: normalizeTemplateText(input.data.description) }
        : {}),
      ...(input.data.active !== undefined ? { active: input.data.active } : {})
    }
  });

  res.json({ template });
});

app.post("/api/projects/:projectId/task-templates/:templateId/runs", async (req, res) => {
  const force = req.body && typeof req.body.force === "boolean" ? req.body.force : false;
  const specBundleId =
    req.body && typeof req.body.specBundleId === "string" && req.body.specBundleId.trim().length > 0
      ? req.body.specBundleId.trim()
      : null;

  const template = await prisma.taskTemplate.findFirst({
    where: {
      projectId: req.params.projectId,
      id: req.params.templateId
    }
  });
  if (!template) {
    return sendError(res, 404, "task template not found");
  }
  if (!template.active) {
    return sendError(res, 409, "task template is inactive");
  }

  try {
    const queued = await queueRunFromTaskTemplate({
      projectId: template.projectId,
      taskTemplateId: template.id,
      taskTemplateName: template.name,
      attractorName: template.attractorName,
      runType: template.runType,
      sourceBranch: template.sourceBranch,
      targetBranch: template.targetBranch,
      environmentMode: template.environmentMode,
      environmentName: template.environmentName,
      launchMode: TaskTemplateLaunchMode.MANUAL,
      force,
      specBundleId
    });
    return res.status(201).json(queued);
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }
});

app.get("/api/projects/:projectId/runs", async (req, res) => {
  const runs = await prisma.run.findMany({
    where: { projectId: req.params.projectId },
    include: {
      githubIssue: true,
      githubPullRequest: true
    },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  res.json({ runs });
});

const createRunSchema = z.object({
  projectId: z.string().min(1),
  attractorDefId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  runType: z.enum(["planning", "implementation", "task"]),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  specBundleId: z.string().optional(),
  force: z.boolean().optional()
});

app.post("/api/runs", async (req, res) => {
  const input = createRunSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  const project = await prisma.project.findUnique({ where: { id: input.data.projectId } });
  if (!project) {
    return sendError(res, 404, "project not found");
  }

  const attractorDef = await prisma.attractorDef.findUnique({ where: { id: input.data.attractorDefId } });
  if (!attractorDef || attractorDef.projectId !== project.id) {
    return sendError(res, 404, "attractor definition not found in project");
  }
  if (!attractorDef.active) {
    return sendError(res, 409, "attractor definition is inactive");
  }
  let modelConfig: RunModelConfig;
  try {
    modelConfig = requireAttractorModelConfig({
      modelConfig: attractorDef.modelConfig,
      attractorName: attractorDef.name
    });
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }

  const providerSecretExists = await hasEffectiveProviderSecret(project.id, modelConfig.provider);
  if (!providerSecretExists) {
    return sendError(
      res,
      409,
      `Missing provider secret for ${modelConfig.provider}. Configure it in Project Secret or Global Secret UI first.`
    );
  }

  let attractorSnapshot;
  try {
    attractorSnapshot = await resolveAttractorSnapshotForRun({
      id: attractorDef.id,
      name: attractorDef.name,
      scope: attractorDef.scope,
      contentPath: attractorDef.contentPath,
      contentVersion: attractorDef.contentVersion
    });
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }

  if (input.data.runType === "planning" && input.data.specBundleId) {
    return sendError(res, 400, "planning runs must not set specBundleId");
  }

  if (input.data.runType === "task" && input.data.specBundleId) {
    return sendError(res, 400, "task runs must not set specBundleId");
  }

  let dotImplementationWithoutSpecBundle = false;
  if (input.data.runType === "implementation" && !input.data.specBundleId) {
    dotImplementationWithoutSpecBundle = await attractorSupportsDotImplementation({
      contentPath: attractorDef.contentPath
    });
    if (!dotImplementationWithoutSpecBundle) {
      return sendError(
        res,
        400,
        "implementation runs require specBundleId unless the attractor enables DOT implementation mode"
      );
    }
  }

  if (input.data.specBundleId) {
    const specBundle = await prisma.specBundle.findUnique({
      where: { id: input.data.specBundleId }
    });
    if (!specBundle) {
      return sendError(res, 404, "spec bundle not found");
    }
    if (specBundle.schemaVersion !== "v1") {
      return sendError(res, 409, `unsupported spec bundle schema version: ${specBundle.schemaVersion}`);
    }
  }

  if (input.data.runType === "implementation" && !input.data.force) {
    const collision = await prisma.run.findFirst({
      where: {
        projectId: project.id,
        runType: RunType.implementation,
        targetBranch: input.data.targetBranch,
        status: { in: [RunStatus.QUEUED, RunStatus.RUNNING] }
      }
    });

    if (collision) {
      return sendError(
        res,
        409,
        `Branch collision: run ${collision.id} is already active on ${input.data.targetBranch}`
      );
    }
  }

  let resolvedEnvironment;
  try {
    resolvedEnvironment = await resolveRunEnvironment({
      projectId: project.id,
      explicitEnvironmentId: input.data.environmentId
    });
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }

  const run = await prisma.run.create({
    data: {
      projectId: project.id,
      attractorDefId: attractorDef.id,
      attractorContentPath: attractorSnapshot.contentPath,
      attractorContentVersion: attractorSnapshot.contentVersion,
      attractorContentSha256: attractorSnapshot.contentSha256,
      environmentId: resolvedEnvironment.id,
      environmentSnapshot: resolvedEnvironment.snapshot as never,
      runType: input.data.runType,
      sourceBranch: input.data.sourceBranch,
      targetBranch: input.data.targetBranch,
      status: RunStatus.QUEUED,
      specBundleId: dotImplementationWithoutSpecBundle ? null : input.data.specBundleId
    }
  });

  await appendRunEvent(run.id, "RunQueued", {
    runId: run.id,
    runType: run.runType,
    projectId: run.projectId,
    targetBranch: run.targetBranch,
    dotImplementationWithoutSpecBundle,
    attractorSnapshot,
    modelConfig,
    environment: resolvedEnvironment.snapshot,
    runnerImage: resolvedEnvironment.snapshot.runnerImage
  });

  await redis.lpush(runQueueKey(), run.id);

  res.status(201).json({ runId: run.id, status: run.status });
});

const createIssueRunSchema = z.object({
  attractorDefId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  runType: z.enum(["planning", "implementation", "task"]).default("implementation"),
  sourceBranch: z.string().min(1).optional(),
  targetBranch: z.string().min(1).optional(),
  specBundleId: z.string().optional(),
  force: z.boolean().optional()
});

app.post("/api/projects/:projectId/github/issues/:issueNumber/runs", async (req, res) => {
  const issueNumber = Number.parseInt(req.params.issueNumber, 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return sendError(res, 400, "issueNumber must be a positive integer");
  }

  const input = createIssueRunSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  const [project, issue] = await Promise.all([
    prisma.project.findUnique({ where: { id: req.params.projectId } }),
    prisma.gitHubIssue.findUnique({
      where: {
        projectId_issueNumber: {
          projectId: req.params.projectId,
          issueNumber
        }
      }
    })
  ]);

  if (!project) {
    return sendError(res, 404, "project not found");
  }
  if (!issue) {
    return sendError(res, 404, "issue not found");
  }
  if (issue.state !== "open") {
    return sendError(res, 409, "issue must be open to launch a run");
  }

  const attractorDef = await prisma.attractorDef.findUnique({
    where: { id: input.data.attractorDefId }
  });
  if (!attractorDef || attractorDef.projectId !== project.id) {
    return sendError(res, 404, "attractor definition not found in project");
  }
  if (!attractorDef.active) {
    return sendError(res, 409, "attractor definition is inactive");
  }
  let modelConfig: RunModelConfig;
  try {
    modelConfig = requireAttractorModelConfig({
      modelConfig: attractorDef.modelConfig,
      attractorName: attractorDef.name
    });
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }

  const providerSecretExists = await hasEffectiveProviderSecret(project.id, modelConfig.provider);
  if (!providerSecretExists) {
    return sendError(
      res,
      409,
      `Missing provider secret for ${modelConfig.provider}. Configure it in Project Secret or Global Secret UI first.`
    );
  }

  let attractorSnapshot;
  try {
    attractorSnapshot = await resolveAttractorSnapshotForRun({
      id: attractorDef.id,
      name: attractorDef.name,
      scope: attractorDef.scope,
      contentPath: attractorDef.contentPath,
      contentVersion: attractorDef.contentVersion
    });
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }

  let resolvedSpecBundleId = input.data.specBundleId;
  let dotImplementationWithoutSpecBundle = false;
  if (input.data.runType === "implementation" && !resolvedSpecBundleId) {
    dotImplementationWithoutSpecBundle = await attractorSupportsDotImplementation({
      contentPath: attractorDef.contentPath
    });
    if (!dotImplementationWithoutSpecBundle) {
      const latestPlanningRun = await prisma.run.findFirst({
        where: {
          projectId: project.id,
          runType: RunType.planning,
          status: RunStatus.SUCCEEDED,
          specBundleId: { not: null }
        },
        orderBy: { finishedAt: "desc" }
      });
      if (!latestPlanningRun?.specBundleId) {
        return sendError(res, 409, "no successful planning run with a spec bundle is available");
      }
      resolvedSpecBundleId = latestPlanningRun.specBundleId;
    }
  }

  let resolvedEnvironment;
  try {
    resolvedEnvironment = await resolveRunEnvironment({
      projectId: project.id,
      explicitEnvironmentId: input.data.environmentId
    });
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }

  const sourceBranch = input.data.sourceBranch ?? project.defaultBranch ?? "main";
  const targetBranch = input.data.targetBranch ?? issueTargetBranch(issue.issueNumber, issue.title);

  const run = await prisma.run.create({
    data: {
      projectId: project.id,
      attractorDefId: attractorDef.id,
      attractorContentPath: attractorSnapshot.contentPath,
      attractorContentVersion: attractorSnapshot.contentVersion,
      attractorContentSha256: attractorSnapshot.contentSha256,
      githubIssueId: issue.id,
      environmentId: resolvedEnvironment.id,
      environmentSnapshot: resolvedEnvironment.snapshot as never,
      runType: input.data.runType,
      sourceBranch,
      targetBranch,
      status: RunStatus.QUEUED,
      specBundleId: resolvedSpecBundleId
    },
    include: {
      githubIssue: true
    }
  });

  await appendRunEvent(run.id, "RunQueued", {
    runId: run.id,
    runType: run.runType,
    projectId: run.projectId,
    targetBranch: run.targetBranch,
    dotImplementationWithoutSpecBundle,
    attractorSnapshot,
    modelConfig,
    environment: resolvedEnvironment.snapshot,
    runnerImage: resolvedEnvironment.snapshot.runnerImage,
    githubIssue: run.githubIssue
      ? {
          id: run.githubIssue.id,
          issueNumber: run.githubIssue.issueNumber,
          title: run.githubIssue.title,
          url: run.githubIssue.url
        }
      : null
  });

  await redis.lpush(runQueueKey(), run.id);

  res.status(201).json({
    runId: run.id,
    status: run.status,
    sourceBranch: run.sourceBranch,
    targetBranch: run.targetBranch,
    githubIssue: run.githubIssue
  });
});

const createPullReviewRunSchema = z.object({
  attractorDefId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  sourceBranch: z.string().min(1).optional(),
  targetBranch: z.string().min(1).optional()
});

app.post("/api/projects/:projectId/github/pulls/:prNumber/runs", async (req, res) => {
  const prNumber = Number.parseInt(req.params.prNumber, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return sendError(res, 400, "prNumber must be a positive integer");
  }

  const input = createPullReviewRunSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  const [project, pullRequest] = await Promise.all([
    prisma.project.findUnique({ where: { id: req.params.projectId } }),
    prisma.gitHubPullRequest.findUnique({
      where: {
        projectId_prNumber: {
          projectId: req.params.projectId,
          prNumber
        }
      }
    })
  ]);

  if (!project) {
    return sendError(res, 404, "project not found");
  }
  if (!pullRequest) {
    return sendError(res, 404, "pull request not found");
  }
  if (pullRequest.state !== "open") {
    return sendError(res, 409, "pull request must be open to launch a review attractor");
  }

  const attractorDef = await prisma.attractorDef.findUnique({
    where: { id: input.data.attractorDefId }
  });
  if (!attractorDef || attractorDef.projectId !== project.id) {
    return sendError(res, 404, "attractor definition not found in project");
  }
  if (!attractorDef.active) {
    return sendError(res, 409, "attractor definition is inactive");
  }
  if (attractorDef.defaultRunType !== RunType.task) {
    return sendError(res, 409, "review attractor must be configured as a task run");
  }
  let modelConfig: RunModelConfig;
  try {
    modelConfig = requireAttractorModelConfig({
      modelConfig: attractorDef.modelConfig,
      attractorName: attractorDef.name
    });
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }

  const providerSecretExists = await hasEffectiveProviderSecret(project.id, modelConfig.provider);
  if (!providerSecretExists) {
    return sendError(
      res,
      409,
      `Missing provider secret for ${modelConfig.provider}. Configure it in Project Secret or Global Secret UI first.`
    );
  }

  let attractorSnapshot;
  try {
    attractorSnapshot = await resolveAttractorSnapshotForRun({
      id: attractorDef.id,
      name: attractorDef.name,
      scope: attractorDef.scope,
      contentPath: attractorDef.contentPath,
      contentVersion: attractorDef.contentVersion
    });
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }

  const attractorContent = await loadAttractorContentFromStorage(attractorSnapshot.contentPath);
  if (!attractorContent) {
    return sendError(
      res,
      409,
      `review attractor content is unavailable at ${attractorSnapshot.contentPath}`
    );
  }

  let reviewFlowNodes;
  try {
    reviewFlowNodes = assertReviewAttractorFlow(attractorContent);
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }

  let resolvedEnvironment;
  try {
    resolvedEnvironment = await resolveRunEnvironment({
      projectId: project.id,
      explicitEnvironmentId: input.data.environmentId
    });
  } catch (error) {
    return sendError(res, 409, error instanceof Error ? error.message : String(error));
  }

  const sourceBranch = input.data.sourceBranch ?? pullRequest.headRefName ?? project.defaultBranch ?? "main";
  const targetBranch = input.data.targetBranch ?? sourceBranch;

  const run = await prisma.run.create({
    data: {
      projectId: project.id,
      attractorDefId: attractorDef.id,
      attractorContentPath: attractorSnapshot.contentPath,
      attractorContentVersion: attractorSnapshot.contentVersion,
      attractorContentSha256: attractorSnapshot.contentSha256,
      githubIssueId: pullRequest.linkedIssueId,
      githubPullRequestId: pullRequest.id,
      environmentId: resolvedEnvironment.id,
      environmentSnapshot: resolvedEnvironment.snapshot as never,
      runType: RunType.task,
      sourceBranch,
      targetBranch,
      status: RunStatus.QUEUED
    },
    include: {
      githubPullRequest: true
    }
  });

  await appendRunEvent(run.id, "RunQueued", {
    runId: run.id,
    runType: run.runType,
    projectId: run.projectId,
    targetBranch: run.targetBranch,
    attractorSnapshot,
    modelConfig,
    environment: resolvedEnvironment.snapshot,
    runnerImage: resolvedEnvironment.snapshot.runnerImage,
    githubPullRequest: run.githubPullRequest
      ? {
          id: run.githubPullRequest.id,
          prNumber: run.githubPullRequest.prNumber,
          title: run.githubPullRequest.title,
          url: run.githubPullRequest.url,
          headSha: run.githubPullRequest.headSha
        }
      : null,
    reviewFlow: {
      fromNodeId: reviewFlowNodes.councilNodeId,
      toNodeId: reviewFlowNodes.summaryNodeId
    }
  });

  await redis.lpush(runQueueKey(), run.id);

  res.status(201).json({
    runId: run.id,
    status: run.status,
    sourceBranch: run.sourceBranch,
    targetBranch: run.targetBranch,
    githubPullRequest: run.githubPullRequest
      ? {
          id: run.githubPullRequest.id,
          prNumber: run.githubPullRequest.prNumber,
          url: run.githubPullRequest.url,
          headSha: run.githubPullRequest.headSha
        }
      : null
  });
});

const selfIterateSchema = z.object({
  attractorDefId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  force: z.boolean().optional()
});

app.post("/api/projects/:projectId/self-iterate", async (req, res) => {
  const input = selfIterateSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  try {
    const queued = await queueSelfIterateImplementationRun({
      projectId: req.params.projectId,
      attractorDefId: input.data.attractorDefId,
      environmentId: input.data.environmentId,
      sourceBranch: input.data.sourceBranch,
      targetBranch: input.data.targetBranch,
      force: input.data.force
    });
    res.status(201).json(queued);
  } catch (error) {
    if (error instanceof ApiError) {
      return sendError(res, error.status, error.message);
    }
    return sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
});

const createAgentSessionSchema = z.object({
  scope: z.enum(["GLOBAL", "PROJECT"]),
  projectId: z.string().min(1).optional(),
  title: z.string().min(1).max(120).optional()
});

const postAgentMessageSchema = z.object({
  content: z.string().min(1).max(20000)
});

app.get("/api/agent/sessions", async (req, res) => {
  const scope = String(req.query.scope ?? "PROJECT").trim().toUpperCase();
  if (scope !== AgentScope.GLOBAL && scope !== AgentScope.PROJECT) {
    return sendError(res, 400, "scope must be GLOBAL or PROJECT");
  }
  const projectId = String(req.query.projectId ?? "").trim();
  if (scope === AgentScope.PROJECT && !projectId) {
    return sendError(res, 400, "projectId is required for PROJECT scope");
  }
  const take = parseLimit(req.query.limit, 50, 200);

  const sessions = await prisma.agentSession.findMany({
    where: {
      archivedAt: null,
      scope: scope as AgentScope,
      ...(scope === AgentScope.PROJECT ? { projectId } : {})
    },
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1
      },
      actions: {
        where: { status: AgentActionStatus.PENDING },
        select: { id: true }
      }
    },
    orderBy: { updatedAt: "desc" },
    take
  });

  res.json({
    sessions: sessions.map((session) => ({
      ...session,
      lastMessagePreview: session.messages[0]?.content
        ? summarizeMessageContent(session.messages[0].content)
        : null,
      pendingActionCount: session.actions.length
    }))
  });
});

app.post("/api/agent/sessions", async (req, res) => {
  const input = createAgentSessionSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }
  if (input.data.scope === AgentScope.PROJECT && !input.data.projectId) {
    return sendError(res, 400, "projectId is required for PROJECT scope");
  }

  if (input.data.scope === AgentScope.PROJECT) {
    const project = await prisma.project.findUnique({ where: { id: input.data.projectId } });
    if (!project) {
      return sendError(res, 404, "project not found");
    }
  }

  const actorEmail = getRequestActorEmail(req);
  const session = await prisma.agentSession.create({
    data: {
      scope: input.data.scope as AgentScope,
      projectId: input.data.scope === AgentScope.PROJECT ? input.data.projectId : null,
      title: input.data.title?.trim() || AGENT_DEFAULT_SESSION_TITLE,
      createdByEmail: actorEmail
    }
  });
  res.status(201).json({ session });
});

app.get("/api/agent/sessions/:sessionId", async (req, res) => {
  const session = await prisma.agentSession.findUnique({
    where: { id: req.params.sessionId },
    include: {
      actions: {
        where: { status: AgentActionStatus.PENDING },
        select: { id: true }
      }
    }
  });
  if (!session || session.archivedAt) {
    return sendError(res, 404, "agent session not found");
  }
  res.json({
    session: {
      ...session,
      pendingActionCount: session.actions.length
    }
  });
});

app.delete("/api/agent/sessions/:sessionId", async (req, res) => {
  const session = await ensureAgentSession(req.params.sessionId).catch((error) => {
    if (error instanceof ApiError) {
      sendError(res, error.status, error.message);
      return null;
    }
    sendError(res, 500, error instanceof Error ? error.message : String(error));
    return null;
  });
  if (!session) {
    return;
  }
  await prisma.agentSession.update({
    where: { id: session.id },
    data: {
      archivedAt: new Date()
    }
  });
  res.status(204).send();
});

app.get("/api/agent/sessions/:sessionId/messages", async (req, res) => {
  let session;
  try {
    session = await ensureAgentSession(req.params.sessionId);
  } catch (error) {
    if (error instanceof ApiError) {
      return sendError(res, error.status, error.message);
    }
    return sendError(res, 500, error instanceof Error ? error.message : String(error));
  }

  const take = parseLimit(req.query.limit, 200, 500);
  const messages = await prisma.agentMessage.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: "asc" },
    take
  });
  const actions = await prisma.agentAction.findMany({
    where: { sessionId: session.id },
    orderBy: [{ requestedAt: "desc" }],
    take: 200
  });

  res.json({ messages, actions });
});

app.post("/api/agent/sessions/:sessionId/messages", async (req, res) => {
  const input = postAgentMessageSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  let session;
  try {
    session = await ensureAgentSession(req.params.sessionId);
  } catch (error) {
    if (error instanceof ApiError) {
      return sendError(res, error.status, error.message);
    }
    return sendError(res, 500, error instanceof Error ? error.message : String(error));
  }

  const actorEmail = getRequestActorEmail(req);
  const userMessage = await prisma.agentMessage.create({
    data: {
      sessionId: session.id,
      role: AgentMessageRole.USER,
      content: input.data.content
    }
  });
  await touchAgentSession(session.id);

  let turnResult: { assistantText: string; usage: unknown; pendingActions: string[] };
  try {
    turnResult = await runAgentTurn({
      session: {
        id: session.id,
        scope: session.scope,
        projectId: session.projectId,
        title: session.title
      },
      userMessage: input.data.content,
      actorEmail
    });
  } catch (error) {
    const failedAssistant = await prisma.agentMessage.create({
      data: {
        sessionId: session.id,
        role: AgentMessageRole.ASSISTANT,
        content: `I hit an error while processing that request: ${error instanceof Error ? error.message : String(error)}`
      }
    });
    await touchAgentSession(session.id);
    return res.status(500).json({
      userMessage,
      assistantMessage: failedAssistant,
      pendingActions: []
    });
  }

  const assistantMessage = await prisma.agentMessage.create({
    data: {
      sessionId: session.id,
      role: AgentMessageRole.ASSISTANT,
      content: turnResult.assistantText,
      tokenUsageJson: turnResult.usage as never
    }
  });
  if (turnResult.pendingActions.length > 0) {
    await prisma.agentAction.updateMany({
      where: { id: { in: turnResult.pendingActions } },
      data: { messageId: assistantMessage.id }
    });
  }
  await touchAgentSession(session.id);

  const pendingActions = await prisma.agentAction.findMany({
    where: {
      sessionId: session.id,
      status: AgentActionStatus.PENDING
    },
    orderBy: { requestedAt: "desc" }
  });

  res.status(201).json({
    userMessage,
    assistantMessage,
    pendingActions
  });
});

app.post("/api/agent/sessions/:sessionId/actions/:actionId/approve", async (req, res) => {
  let session;
  try {
    session = await ensureAgentSession(req.params.sessionId);
  } catch (error) {
    if (error instanceof ApiError) {
      return sendError(res, error.status, error.message);
    }
    return sendError(res, 500, error instanceof Error ? error.message : String(error));
  }

  const action = await prisma.agentAction.findFirst({
    where: {
      id: req.params.actionId,
      sessionId: session.id
    }
  });
  if (!action) {
    return sendError(res, 404, "action not found");
  }
  if (action.status !== AgentActionStatus.PENDING) {
    return sendError(res, 409, `action is already ${action.status}`);
  }

  const actorEmail = getRequestActorEmail(req);
  let updatedAction;
  let assistantContent = "";
  try {
    const result = await executeApprovedAgentAction({
      type: action.type,
      argsJson: action.argsJson
    }, {
      scope: session.scope,
      projectId: session.projectId
    });
    updatedAction = await prisma.agentAction.update({
      where: { id: action.id },
      data: {
        status: AgentActionStatus.EXECUTED,
        resultJson: result as never,
        resolvedByEmail: actorEmail,
        resolvedAt: new Date()
      }
    });
    assistantContent = `Approved and executed: ${action.summary}`;
  } catch (error) {
    updatedAction = await prisma.agentAction.update({
      where: { id: action.id },
      data: {
        status: AgentActionStatus.FAILED,
        error: error instanceof Error ? error.message : String(error),
        resolvedByEmail: actorEmail,
        resolvedAt: new Date()
      }
    });
    assistantContent = `Execution failed for ${action.summary}: ${updatedAction.error ?? "unknown error"}`;
  }

  const assistantMessage = await prisma.agentMessage.create({
    data: {
      sessionId: session.id,
      role: AgentMessageRole.ASSISTANT,
      content: assistantContent
    }
  });
  await touchAgentSession(session.id);
  res.json({ action: updatedAction, assistantMessage });
});

app.post("/api/agent/sessions/:sessionId/actions/:actionId/reject", async (req, res) => {
  let session;
  try {
    session = await ensureAgentSession(req.params.sessionId);
  } catch (error) {
    if (error instanceof ApiError) {
      return sendError(res, error.status, error.message);
    }
    return sendError(res, 500, error instanceof Error ? error.message : String(error));
  }

  const action = await prisma.agentAction.findFirst({
    where: {
      id: req.params.actionId,
      sessionId: session.id
    }
  });
  if (!action) {
    return sendError(res, 404, "action not found");
  }
  if (action.status !== AgentActionStatus.PENDING) {
    return sendError(res, 409, `action is already ${action.status}`);
  }

  const actorEmail = getRequestActorEmail(req);
  const updatedAction = await prisma.agentAction.update({
    where: { id: action.id },
    data: {
      status: AgentActionStatus.REJECTED,
      resolvedByEmail: actorEmail,
      resolvedAt: new Date()
    }
  });

  const assistantMessage = await prisma.agentMessage.create({
    data: {
      sessionId: session.id,
      role: AgentMessageRole.ASSISTANT,
      content: `Rejected: ${action.summary}`
    }
  });
  await touchAgentSession(session.id);
  res.json({ action: updatedAction, assistantMessage });
});

const runReviewChecklistSchema = z.object({
  summaryReviewed: z.boolean(),
  criticalCodeReviewed: z.boolean(),
  artifactsReviewed: z.boolean(),
  functionalValidationReviewed: z.boolean()
});

const upsertRunReviewSchema = z.object({
  reviewer: z.string().min(2).max(120),
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "EXCEPTION"]),
  checklist: runReviewChecklistSchema,
  summary: z.string().max(20000).optional(),
  criticalFindings: z.string().max(20000).optional(),
  artifactFindings: z.string().max(20000).optional(),
  attestation: z.string().max(20000).optional()
});

app.get("/api/runs/:runId", async (req, res) => {
  const run = await prisma.run.findUnique({
    where: { id: req.params.runId },
    include: {
      githubIssue: true,
      githubPullRequest: true,
      environment: true,
      events: {
        orderBy: { ts: "asc" },
        take: 200
      }
    }
  });
  if (!run) {
    return sendError(res, 404, "run not found");
  }
  res.json(run);
});

app.get("/api/runs/:runId/questions", async (req, res) => {
  const run = await prisma.run.findUnique({ where: { id: req.params.runId } });
  if (!run) {
    return sendError(res, 404, "run not found");
  }

  const questions = await prisma.runQuestion.findMany({
    where: { runId: run.id },
    orderBy: { createdAt: "asc" }
  });

  res.json({ questions });
});

const answerRunQuestionSchema = z.object({
  answer: z.string().min(1)
});

app.post("/api/runs/:runId/questions/:questionId/answer", async (req, res) => {
  const input = answerRunQuestionSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  const run = await prisma.run.findUnique({ where: { id: req.params.runId } });
  if (!run) {
    return sendError(res, 404, "run not found");
  }

  const question = await prisma.runQuestion.findFirst({
    where: {
      id: req.params.questionId,
      runId: run.id
    }
  });
  if (!question) {
    return sendError(res, 404, "question not found for run");
  }
  if (question.status !== RunQuestionStatus.PENDING) {
    return sendError(res, 409, "question is not pending");
  }

  const updated = await prisma.runQuestion.update({
    where: { id: question.id },
    data: {
      answer: { text: input.data.answer },
      status: RunQuestionStatus.ANSWERED,
      answeredAt: new Date()
    }
  });

  res.json({ question: updated });
});

app.get("/api/runs/:runId/events", async (req, res) => {
  const run = await prisma.run.findUnique({ where: { id: req.params.runId } });
  if (!run) {
    return sendError(res, 404, "run not found");
  }

  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const initialEvents = await prisma.runEvent.findMany({
    where: { runId: run.id },
    orderBy: { ts: "asc" },
    take: 200
  });

  for (const event of initialEvents) {
    res.write(`data: ${JSON.stringify({
      id: event.id,
      runId: event.runId,
      ts: event.ts.toISOString(),
      type: event.type,
      payload: event.payload
    })}\n\n`);
  }

  const sub = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  await sub.subscribe(runEventChannel(run.id));
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
  }, 25000);

  sub.on("message", (_channel: string, message: string) => {
    res.write(`data: ${message}\n\n`);
  });

  req.on("close", async () => {
    clearInterval(heartbeat);
    await sub.unsubscribe(runEventChannel(run.id));
    sub.disconnect();
  });
});

app.get("/api/runs/:runId/artifacts", async (req, res) => {
  const artifacts = await prisma.artifact.findMany({
    where: { runId: req.params.runId },
    orderBy: { createdAt: "asc" }
  });

  const specBundle = await prisma.specBundle.findFirst({ where: { runId: req.params.runId } });
  res.json({ artifacts, specBundle });
});

app.get("/api/runs/:runId/review", async (req, res) => {
  const reviewPack = await buildRunReviewPack(req.params.runId);
  if (!reviewPack) {
    return sendError(res, 404, "run not found");
  }

  res.json({
    frameworkVersion: RUN_REVIEW_FRAMEWORK_VERSION,
    review: reviewPack.review
      ? {
          ...reviewPack.review,
          checklist: normalizeStoredChecklist(reviewPack.review.checklistJson)
        }
      : null,
    checklistTemplate: reviewPack.checklistTemplate,
    pack: reviewPack.pack,
    github: {
      pullRequest: reviewPack.run.githubPullRequest
    }
  });
});

app.put("/api/runs/:runId/review", async (req, res) => {
  const input = upsertRunReviewSchema.safeParse(req.body);
  if (!input.success) {
    return sendError(res, 400, input.error.message);
  }

  const run = await prisma.run.findUnique({
    where: { id: req.params.runId },
    include: {
      project: true,
      githubPullRequest: true
    }
  });
  if (!run) {
    return sendError(res, 404, "run not found");
  }

  const feedbackPresent = hasFeedbackText({
    summary: input.data.summary,
    criticalFindings: input.data.criticalFindings,
    artifactFindings: input.data.artifactFindings
  });
  const effectiveDecisionValue = effectiveReviewDecision(
    input.data.decision as ReviewDecision,
    feedbackPresent
  );
  if (
    effectiveDecisionValue === ReviewDecision.APPROVE &&
    !Object.values(input.data.checklist).every((item) => item === true)
  ) {
    return sendError(res, 400, "All checklist items must be completed before approval.");
  }
  if (
    effectiveDecisionValue !== ReviewDecision.APPROVE &&
    !feedbackPresent &&
    !toNullableText(input.data.attestation)
  ) {
    return sendError(res, 400, "Non-approval outcomes require reviewer notes.");
  }

  const pack = await buildRunReviewPack(run.id);
  const reviewedHeadSha = pack?.run.githubPullRequest?.headSha ?? run.githubPullRequest?.headSha ?? null;

  const persisted = await prisma.runReview.upsert({
    where: { runId: run.id },
    update: {
      reviewer: input.data.reviewer,
      decision: effectiveDecisionValue,
      checklistJson: input.data.checklist as never,
      summary: toNullableText(input.data.summary),
      criticalFindings: toNullableText(input.data.criticalFindings),
      artifactFindings: toNullableText(input.data.artifactFindings),
      attestation: toNullableText(input.data.attestation),
      reviewedHeadSha,
      summarySnapshotJson: pack ? (pack.pack.summarySuggestion as never) : undefined,
      criticalSectionsSnapshotJson: (pack?.pack.criticalSections ?? []) as never,
      artifactFocusSnapshotJson: (pack?.pack.artifactFocus ?? []) as never,
      reviewedAt: new Date()
    },
    create: {
      runId: run.id,
      reviewer: input.data.reviewer,
      decision: effectiveDecisionValue,
      checklistJson: input.data.checklist as never,
      summary: toNullableText(input.data.summary),
      criticalFindings: toNullableText(input.data.criticalFindings),
      artifactFindings: toNullableText(input.data.artifactFindings),
      attestation: toNullableText(input.data.attestation),
      reviewedHeadSha,
      summarySnapshotJson: pack ? (pack.pack.summarySuggestion as never) : undefined,
      criticalSectionsSnapshotJson: (pack?.pack.criticalSections ?? []) as never,
      artifactFocusSnapshotJson: (pack?.pack.artifactFocus ?? []) as never,
      reviewedAt: new Date()
    }
  });

  let writebackStatus = "NOT_LINKED";
  if (run.githubPullRequestId && run.project.githubInstallationId && run.project.repoFullName) {
    try {
      const writeback = await postReviewWriteback(persisted.id);
      await prisma.runReview.update({
        where: { id: persisted.id },
        data: {
          githubCheckRunId: writeback.githubCheckRunId,
          githubSummaryCommentId: writeback.githubSummaryCommentId,
          githubWritebackStatus: "SUCCEEDED",
          githubWritebackAt: new Date()
        }
      });
      writebackStatus = "SUCCEEDED";
    } catch (error) {
      await prisma.runReview.update({
        where: { id: persisted.id },
        data: {
          githubWritebackStatus: "FAILED",
          githubWritebackAt: new Date()
        }
      });
      writebackStatus = "FAILED";
      const retryReviewId = persisted.id;
      setTimeout(() => {
        void (async () => {
          try {
            const retryResult = await postReviewWriteback(retryReviewId);
            await prisma.runReview.update({
              where: { id: retryReviewId },
              data: {
                githubCheckRunId: retryResult.githubCheckRunId,
                githubSummaryCommentId: retryResult.githubSummaryCommentId,
                githubWritebackStatus: "SUCCEEDED",
                githubWritebackAt: new Date()
              }
            });
          } catch {
            // Keep FAILED status after one async retry.
          }
        })();
      }, 5000);
      process.stderr.write(
        `review writeback failed for run ${run.id}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  await appendRunEvent(run.id, "RunReviewUpdated", {
    runId: run.id,
    reviewer: persisted.reviewer,
    requestedDecision: input.data.decision,
    decision: persisted.decision,
    feedbackPresent,
    effectiveDecision: effectiveDecisionValue,
    githubWritebackStatus: writebackStatus
  });

  const refreshed = await prisma.runReview.findUnique({ where: { id: persisted.id } });
  res.json({
    effectiveDecision: effectiveDecisionValue,
    feedbackPresent,
    review: {
      ...(refreshed ?? persisted),
      checklist: normalizeStoredChecklist((refreshed ?? persisted).checklistJson)
    }
  });
});

app.get("/api/runs/:runId/artifacts/:artifactId/content", async (req, res) => {
  const artifact = await getArtifactByRun(req.params.runId, req.params.artifactId);
  if (!artifact) {
    return sendError(res, 404, "artifact not found for run");
  }

  const previewBytes = clampPreviewBytes(req.query.previewBytes);
  const head = await minioClient.send(
    new HeadObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: artifact.path
    })
  );
  const contentLength = Number(head.ContentLength ?? 0);
  const contentType = head.ContentType ?? artifact.contentType ?? undefined;

  const preview = await minioClient.send(
    new GetObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: artifact.path,
      Range: `bytes=0-${previewBytes - 1}`
    })
  );

  if (!preview.Body) {
    throw new Error(`artifact ${artifact.id} has no object body`);
  }

  const bytes = await bodyToBuffer(preview.Body);
  const isText = isTextByMetadata(contentType, artifact.key) || isProbablyText(bytes);
  const truncated = isText ? contentLength > bytes.length : false;
  const encoding = isText ? "utf-8" : null;

  res.json({
    artifact: {
      id: artifact.id,
      key: artifact.key,
      path: artifact.path,
      contentType,
      sizeBytes: contentLength || artifact.sizeBytes || undefined
    },
    content: isText ? bytes.toString("utf8") : null,
    truncated,
    bytesRead: bytes.length,
    encoding
  });
});

app.get("/api/runs/:runId/artifacts/:artifactId/download", async (req, res) => {
  const artifact = await getArtifactByRun(req.params.runId, req.params.artifactId);
  if (!artifact) {
    return sendError(res, 404, "artifact not found for run");
  }

  const output = await minioClient.send(
    new GetObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: artifact.path
    })
  );

  if (!output.Body) {
    throw new Error(`artifact ${artifact.id} has no object body`);
  }

  const contentType = output.ContentType ?? artifact.contentType ?? "application/octet-stream";
  const contentLength = Number(output.ContentLength ?? artifact.sizeBytes ?? 0);
  const filename = artifact.key.replace(/"/g, "");

  res.setHeader("content-type", contentType);
  if (contentLength > 0) {
    res.setHeader("content-length", String(contentLength));
  }
  res.setHeader("content-disposition", `attachment; filename="${filename}"`);

  const body = output.Body;
  if (body instanceof Readable) {
    body.pipe(res);
    return;
  }

  const bytes = await bodyToBuffer(body);
  res.end(bytes);
});

app.post("/api/runs/:runId/cancel", async (req, res) => {
  const run = await prisma.run.findUnique({ where: { id: req.params.runId } });
  if (!run) {
    return sendError(res, 404, "run not found");
  }

  if (run.status !== RunStatus.QUEUED && run.status !== RunStatus.RUNNING) {
    return sendError(res, 409, `run is already terminal (${run.status})`);
  }

  const updated = await prisma.run.update({
    where: { id: run.id },
    data: {
      status: RunStatus.CANCELED,
      finishedAt: new Date()
    }
  });

  await redis.set(runCancelKey(run.id), "1", "EX", 7200);
  await appendRunEvent(run.id, "RunCanceled", { runId: run.id });

  if (run.runType === RunType.implementation) {
    await redis.del(runLockKey(run.projectId, run.targetBranch));
  }

  res.json({ runId: updated.id, status: updated.status });
});

app.post("/api/github/webhooks", express.raw({ type: "*/*" }), async (req, res) => {
  if (!(await isGitHubSyncEnabled())) {
    return sendError(res, 503, "GitHub sync is disabled");
  }
  const webhookSecret = await resolveGitHubWebhookSecret();
  if (!webhookSecret) {
    return sendError(res, 503, "GitHub webhook secret is not configured");
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""), "utf8");
  const signature = req.header("x-hub-signature-256");
  const valid = verifyGitHubWebhookSignature({
    rawBody,
    signatureHeader: signature,
    secret: webhookSecret
  });
  if (!valid) {
    return sendError(res, 401, "invalid webhook signature");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    return sendError(res, 400, "invalid webhook payload");
  }

  const eventName = req.header("x-github-event")?.trim() ?? "";
  const installationId = String(
    ((payload.installation as { id?: unknown } | undefined)?.id ?? "")
  );
  const repositoryFullName = String(
    ((payload.repository as { full_name?: unknown } | undefined)?.full_name ?? "")
  );
  if (!installationId || !repositoryFullName) {
    return res.status(202).json({ accepted: true, ignored: true, reason: "missing installation/repository" });
  }

  const project = await prisma.project.findFirst({
    where: {
      githubInstallationId: installationId,
      repoFullName: repositoryFullName
    }
  });
  if (!project) {
    return res.status(202).json({ accepted: true, ignored: true, reason: "project not mapped" });
  }

  const action = String(payload.action ?? "");
  let issueRecord:
    | {
        id: string;
        issueNumber: number;
        title: string;
        state: string;
        labelsJson: unknown | null;
        updatedAt: Date;
      }
    | null = null;
  let pullRecord:
    | {
        id: string;
        prNumber: number;
        title: string;
        state: string;
        headRefName: string;
        headSha: string;
        baseRefName: string;
        mergedAt: Date | null;
        updatedAt: Date;
        linkedIssueId: string | null;
      }
    | null = null;
  let triggerContext: TaskTemplateTriggerContext | null = null;

  if (eventName === "issues" && ["opened", "edited", "reopened", "closed", "labeled"].includes(action)) {
    const issue = payload.issue as {
      number: number;
      state: string;
      title: string;
      body?: string | null;
      user?: { login?: string | null } | null;
      labels?: Array<string | { name?: string | null } | null> | null;
      assignees?: Array<{ login?: string | null } | null> | null;
      html_url: string;
      created_at: string;
      closed_at?: string | null;
      updated_at: string;
    } | undefined;
    if (issue) {
      issueRecord = await upsertGitHubIssueForProject({
        projectId: project.id,
        issue
      });

      const labels = Array.isArray(issueRecord.labelsJson)
        ? (issueRecord.labelsJson as string[])
        : normalizeIssueLabels(issue.labels);

      if (action === "opened") {
        triggerContext = {
          event: "GITHUB_ISSUE_OPENED",
          action,
          issue: {
            number: issueRecord.issueNumber,
            title: issueRecord.title,
            state: issueRecord.state,
            labels,
            updatedAt: issueRecord.updatedAt.toISOString()
          }
        };
      } else if (action === "reopened") {
        triggerContext = {
          event: "GITHUB_ISSUE_REOPENED",
          action,
          issue: {
            number: issueRecord.issueNumber,
            title: issueRecord.title,
            state: issueRecord.state,
            labels,
            updatedAt: issueRecord.updatedAt.toISOString()
          }
        };
      } else if (action === "labeled") {
        const labeledName =
          typeof (payload.label as { name?: unknown } | undefined)?.name === "string"
            ? ((payload.label as { name?: string }).name ?? "").trim()
            : "";
        triggerContext = {
          event: "GITHUB_ISSUE_LABELED",
          action,
          issue: {
            number: issueRecord.issueNumber,
            title: issueRecord.title,
            state: issueRecord.state,
            labels,
            updatedAt: issueRecord.updatedAt.toISOString()
          },
          labeledName
        };
      }
    }
  }

  if (eventName === "pull_request" && ["opened", "edited", "reopened", "closed", "synchronize"].includes(action)) {
    const pullRequest = payload.pull_request as {
      number: number;
      state: string;
      title: string;
      body?: string | null;
      html_url: string;
      head: { ref: string; sha: string };
      base: { ref: string };
      created_at: string;
      closed_at?: string | null;
      merged_at?: string | null;
      updated_at: string;
    } | undefined;
    if (pullRequest) {
      pullRecord = await upsertGitHubPullRequestForProject({
        projectId: project.id,
        pullRequest
      });

      if (action === "opened") {
        triggerContext = {
          event: "GITHUB_PR_OPENED",
          action,
          pullRequest: {
            number: pullRecord.prNumber,
            state: pullRecord.state,
            title: pullRecord.title,
            headRefName: pullRecord.headRefName,
            headSha: pullRecord.headSha,
            baseRefName: pullRecord.baseRefName,
            mergedAt: pullRecord.mergedAt?.toISOString() ?? null,
            updatedAt: pullRecord.updatedAt.toISOString()
          }
        };
      } else if (action === "synchronize") {
        triggerContext = {
          event: "GITHUB_PR_SYNCHRONIZE",
          action,
          pullRequest: {
            number: pullRecord.prNumber,
            state: pullRecord.state,
            title: pullRecord.title,
            headRefName: pullRecord.headRefName,
            headSha: pullRecord.headSha,
            baseRefName: pullRecord.baseRefName,
            mergedAt: pullRecord.mergedAt?.toISOString() ?? null,
            updatedAt: pullRecord.updatedAt.toISOString()
          }
        };
      } else if (action === "closed" && pullRecord.mergedAt) {
        triggerContext = {
          event: "GITHUB_PR_MERGED",
          action,
          pullRequest: {
            number: pullRecord.prNumber,
            state: pullRecord.state,
            title: pullRecord.title,
            headRefName: pullRecord.headRefName,
            headSha: pullRecord.headSha,
            baseRefName: pullRecord.baseRefName,
            mergedAt: pullRecord.mergedAt.toISOString(),
            updatedAt: pullRecord.updatedAt.toISOString()
          }
        };
      }
    }
  }

  if (eventName === "issue_comment" && action === "created") {
    const issue = payload.issue as {
      number: number;
      state: string;
      title: string;
      body?: string | null;
      user?: { login?: string | null } | null;
      labels?: Array<string | { name?: string | null } | null> | null;
      assignees?: Array<{ login?: string | null } | null> | null;
      html_url: string;
      created_at: string;
      closed_at?: string | null;
      updated_at: string;
    } | undefined;
    const comment = payload.comment as {
      id: number;
      body?: string | null;
      user?: { login?: string | null; type?: string | null } | null;
    } | undefined;
    if (issue && comment) {
      issueRecord = await upsertGitHubIssueForProject({
        projectId: project.id,
        issue
      });
      const authorLogin = comment.user?.login ?? null;
      const authorType = comment.user?.type ?? null;
      if (isHumanActor(authorType, authorLogin)) {
        const labels = Array.isArray(issueRecord.labelsJson)
          ? (issueRecord.labelsJson as string[])
          : normalizeIssueLabels(issue.labels);
        triggerContext = {
          event: "GITHUB_ISSUE_COMMENT_CREATED",
          action,
          issue: {
            number: issueRecord.issueNumber,
            title: issueRecord.title,
            state: issueRecord.state,
            labels,
            updatedAt: issueRecord.updatedAt.toISOString()
          },
          comment: {
            id: comment.id,
            body: comment.body ?? "",
            authorLogin,
            authorType
          }
        };
      }
    }
  }

  if (eventName === "pull_request_review" && action === "submitted") {
    const pullRequest = payload.pull_request as {
      number: number;
      state: string;
      title: string;
      body?: string | null;
      html_url: string;
      head: { ref: string; sha: string };
      base: { ref: string };
      created_at: string;
      closed_at?: string | null;
      merged_at?: string | null;
      updated_at: string;
    } | undefined;
    const review = payload.review as {
      id: number;
      state?: string | null;
      body?: string | null;
      user?: { login?: string | null; type?: string | null } | null;
    } | undefined;
    if (pullRequest && review) {
      pullRecord = await upsertGitHubPullRequestForProject({
        projectId: project.id,
        pullRequest
      });
      const reviewState = (review.state ?? "").toLowerCase();
      const authorLogin = review.user?.login ?? null;
      const authorType = review.user?.type ?? null;
      if (reviewState === "changes_requested" && isHumanActor(authorType, authorLogin)) {
        triggerContext = {
          event: "GITHUB_PR_REVIEW_CHANGES_REQUESTED",
          action,
          pullRequest: {
            number: pullRecord.prNumber,
            state: pullRecord.state,
            title: pullRecord.title,
            headRefName: pullRecord.headRefName,
            headSha: pullRecord.headSha,
            baseRefName: pullRecord.baseRefName,
            mergedAt: pullRecord.mergedAt?.toISOString() ?? null,
            updatedAt: pullRecord.updatedAt.toISOString()
          },
          review: {
            id: review.id,
            body: review.body ?? "",
            state: reviewState,
            authorLogin,
            authorType
          }
        };
      }
    }
  }

  if (eventName === "pull_request_review_comment" && action === "created") {
    const pullRequest = payload.pull_request as {
      number: number;
      state: string;
      title: string;
      body?: string | null;
      html_url: string;
      head: { ref: string; sha: string };
      base: { ref: string };
      created_at: string;
      closed_at?: string | null;
      merged_at?: string | null;
      updated_at: string;
    } | undefined;
    const comment = payload.comment as {
      id: number;
      body?: string | null;
      user?: { login?: string | null; type?: string | null } | null;
    } | undefined;
    if (pullRequest && comment) {
      pullRecord = await upsertGitHubPullRequestForProject({
        projectId: project.id,
        pullRequest
      });
      const authorLogin = comment.user?.login ?? null;
      const authorType = comment.user?.type ?? null;
      if (isHumanActor(authorType, authorLogin)) {
        triggerContext = {
          event: "GITHUB_PR_REVIEW_COMMENT_CREATED",
          action,
          pullRequest: {
            number: pullRecord.prNumber,
            state: pullRecord.state,
            title: pullRecord.title,
            headRefName: pullRecord.headRefName,
            headSha: pullRecord.headSha,
            baseRefName: pullRecord.baseRefName,
            mergedAt: pullRecord.mergedAt?.toISOString() ?? null,
            updatedAt: pullRecord.updatedAt.toISOString()
          },
          reviewComment: {
            id: comment.id,
            body: comment.body ?? "",
            authorLogin,
            authorType
          }
        };
      }
    }
  }

  await prisma.gitHubSyncState.upsert({
    where: { projectId: project.id },
    update: {
      lastIssueSyncAt: new Date(),
      lastPullSyncAt: new Date(),
      issuesCursor: new Date().toISOString(),
      pullsCursor: new Date().toISOString(),
      lastError: null
    },
    create: {
      projectId: project.id,
      lastIssueSyncAt: new Date(),
      lastPullSyncAt: new Date(),
      issuesCursor: new Date().toISOString(),
      pullsCursor: new Date().toISOString(),
      lastError: null
    }
  });

  if (triggerContext) {
    try {
      await triggerTaskTemplatesForEvent({
        project: {
          id: project.id,
          defaultBranch: project.defaultBranch
        },
        deliveryId: req.header("x-github-delivery")?.trim() || null,
        context: triggerContext,
        githubIssueId: issueRecord?.id ?? pullRecord?.linkedIssueId ?? null,
        githubPullRequestId: pullRecord?.id ?? null
      });
    } catch (error) {
      process.stderr.write(
        `task template trigger failed project=${project.id} event=${eventName}/${action}: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    }
  }

  res.json({ accepted: true, event: eventName, action, projectId: project.id });
});

app.post("/api/projects/:projectId/github/reconcile", async (req, res) => {
  try {
    const result = await reconcileProjectGitHub(req.params.projectId);
    res.json({ projectId: req.params.projectId, ...result });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
});

app.get("/api/projects/:projectId/github/issues", async (req, res) => {
  const stateFilter = String(req.query.state ?? "all").trim();
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const take = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 200);
  const issues = await prisma.gitHubIssue.findMany({
    where: {
      projectId: req.params.projectId,
      ...(stateFilter !== "all" ? { state: stateFilter } : {})
    },
    orderBy: [{ updatedAt: "desc" }],
    include: {
      _count: {
        select: {
          runs: true,
          pullRequests: true
        }
      }
    },
    take
  });

  const filtered = q
    ? issues.filter((issue) => {
        return (
          issue.title.toLowerCase().includes(q) ||
          (issue.body ?? "").toLowerCase().includes(q) ||
          issue.issueNumber.toString().includes(q)
        );
      })
    : issues;

  res.json({
    issues: filtered.map((issue) => ({
      ...issue,
      runCount: issue._count.runs,
      pullRequestCount: issue._count.pullRequests
    }))
  });
});

app.get("/api/projects/:projectId/github/issues/:issueNumber", async (req, res) => {
  const issueNumber = Number.parseInt(req.params.issueNumber, 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return sendError(res, 400, "issueNumber must be a positive integer");
  }

  const issue = await prisma.gitHubIssue.findUnique({
    where: {
      projectId_issueNumber: {
        projectId: req.params.projectId,
        issueNumber
      }
    }
  });
  if (!issue) {
    return sendError(res, 404, "issue not found");
  }

  const [runs, pullRequests, attractors, project] = await Promise.all([
    prisma.run.findMany({
      where: { githubIssueId: issue.id },
      include: {
        review: true,
        githubPullRequest: true
      },
      orderBy: { createdAt: "desc" },
      take: 50
    }),
    prisma.gitHubPullRequest.findMany({
      where: { linkedIssueId: issue.id },
      orderBy: { updatedAt: "desc" },
      take: 50
    }),
    prisma.attractorDef.findMany({
      where: {
        projectId: req.params.projectId,
        active: true
      },
      orderBy: { createdAt: "desc" }
    }),
    prisma.project.findUnique({ where: { id: req.params.projectId } })
  ]);

  res.json({
    issue,
    runs,
    pullRequests,
    launchDefaults: {
      sourceBranch: project?.defaultBranch ?? "main",
      targetBranch: issueTargetBranch(issue.issueNumber, issue.title),
      attractorOptions: attractors.map((attractor) => ({
        id: attractor.id,
        name: attractor.name,
        defaultRunType: attractor.defaultRunType,
        modelConfig: attractor.modelConfig
      }))
    }
  });
});

app.get("/api/projects/:projectId/github/pulls", async (req, res) => {
  const stateFilter = String(req.query.state ?? "all").trim();
  const take = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 200);
  const pulls = await prisma.gitHubPullRequest.findMany({
    where: {
      projectId: req.params.projectId,
      ...(stateFilter !== "all" ? { state: stateFilter } : {})
    },
    include: {
      linkedIssue: true
    },
    orderBy: [{ openedAt: "desc" }],
    take
  });

  const pullIds = pulls.map((pull) => pull.id);
  const linkedRuns = pullIds.length
    ? await prisma.run.findMany({
        where: {
          githubPullRequestId: { in: pullIds }
        },
        include: {
          review: true,
          _count: {
            select: { artifacts: true }
          }
        },
        orderBy: { createdAt: "desc" }
      })
    : [];
  const runByPull = new Map<string, (typeof linkedRuns)[number]>();
  for (const run of linkedRuns) {
    if (run.githubPullRequestId && !runByPull.has(run.githubPullRequestId)) {
      runByPull.set(run.githubPullRequestId, run);
    }
  }

  const now = Date.now();
  const rows = pulls.map((pull) => {
    const linkedRun = runByPull.get(pull.id) ?? null;
    const dueAt = new Date(pull.openedAt.getTime() + 24 * 60 * 60 * 1000);
    const minutesRemaining = Math.ceil((dueAt.getTime() - now) / 60000);
    const stale = isReviewRunStale({
      currentHeadSha: pull.headSha,
      reviewedHeadSha: linkedRun?.review?.reviewedHeadSha
    });
    const reviewStatus = pullReviewStatus({
      hasReview: Boolean(linkedRun?.review),
      stale,
      minutesRemaining
    });
    const criticalCount = Array.isArray(linkedRun?.review?.criticalSectionsSnapshotJson)
      ? (linkedRun?.review?.criticalSectionsSnapshotJson as unknown[]).length
      : 0;
    const risk = inferPrRiskLevel({
      title: pull.title,
      body: pull.body,
      headRefName: pull.headRefName
    });
    return {
      pullRequest: pull,
      linkedRunId: linkedRun?.id ?? null,
      reviewDecision: linkedRun?.review?.decision ?? null,
      reviewStatus,
      stale,
      staleReason:
        stale && linkedRun?.review?.reviewedHeadSha
          ? `Last reviewed SHA ${linkedRun.review.reviewedHeadSha.slice(0, 12)} differs from current head ${pull.headSha.slice(0, 12)}.`
          : null,
      risk,
      dueAt: dueAt.toISOString(),
      minutesRemaining,
      criticalCount,
      artifactCount: linkedRun?._count.artifacts ?? 0,
      openPackPath: linkedRun ? `/runs/${linkedRun.id}?tab=review` : null
    };
  });

  res.json({ pulls: rows });
});

app.get("/api/projects/:projectId/github/pulls/:prNumber", async (req, res) => {
  const prNumber = Number.parseInt(req.params.prNumber, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return sendError(res, 400, "prNumber must be a positive integer");
  }

  const pullRequest = await prisma.gitHubPullRequest.findUnique({
    where: {
      projectId_prNumber: {
        projectId: req.params.projectId,
        prNumber
      }
    },
    include: {
      linkedIssue: true
    }
  });
  if (!pullRequest) {
    return sendError(res, 404, "pull request not found");
  }

  const linkedRun = await prisma.run.findFirst({
    where: { githubPullRequestId: pullRequest.id },
    include: {
      review: true,
      _count: {
        select: { artifacts: true }
      }
    },
    orderBy: { createdAt: "desc" }
  });
  const [project, attractors] = await Promise.all([
    prisma.project.findUnique({
      where: { id: req.params.projectId },
      select: { defaultBranch: true }
    }),
    prisma.attractorDef.findMany({
      where: {
        projectId: req.params.projectId,
        active: true,
        defaultRunType: RunType.task
      },
      orderBy: { createdAt: "desc" }
    })
  ]);

  const dueAt = new Date(pullRequest.openedAt.getTime() + 24 * 60 * 60 * 1000);
  const minutesRemaining = Math.ceil((dueAt.getTime() - Date.now()) / 60000);
  const stale = isReviewRunStale({
    currentHeadSha: pullRequest.headSha,
    reviewedHeadSha: linkedRun?.review?.reviewedHeadSha
  });
  const reviewStatus = pullReviewStatus({
    hasReview: Boolean(linkedRun?.review),
    stale,
    minutesRemaining
  });
  const defaultSourceBranch = pullRequest.headRefName || project?.defaultBranch || "main";

  res.json({
    pull: {
      pullRequest,
      linkedRunId: linkedRun?.id ?? null,
      reviewDecision: linkedRun?.review?.decision ?? null,
      reviewStatus,
      stale,
      staleReason:
        stale && linkedRun?.review?.reviewedHeadSha
          ? `Last reviewed SHA ${linkedRun.review.reviewedHeadSha.slice(0, 12)} differs from current head ${pullRequest.headSha.slice(0, 12)}.`
          : null,
      risk: inferPrRiskLevel({
        title: pullRequest.title,
        body: pullRequest.body,
        headRefName: pullRequest.headRefName
      }),
      dueAt: dueAt.toISOString(),
      minutesRemaining,
      criticalCount: Array.isArray(linkedRun?.review?.criticalSectionsSnapshotJson)
        ? (linkedRun?.review?.criticalSectionsSnapshotJson as unknown[]).length
        : 0,
      artifactCount: linkedRun?._count.artifacts ?? 0,
      openPackPath: linkedRun ? `/runs/${linkedRun.id}?tab=review` : null
    },
    launchDefaults: {
      sourceBranch: defaultSourceBranch,
      targetBranch: defaultSourceBranch,
      attractorOptions: attractors.map((attractor) => ({
        id: attractor.id,
        name: attractor.name,
        defaultRunType: attractor.defaultRunType,
        modelConfig: attractor.modelConfig
      }))
    }
  });
});

app.get("/api/github/app/status", async (_req, res) => {
  const credentials = await resolveGitHubAppCredentials();
  const webhookSecret = await resolveGitHubWebhookSecret();
  res.json({
    configured: !!credentials,
    source: credentials?.source ?? "none",
    appId: credentials?.appId ?? null,
    appSlug: credentials?.appSlug ?? null,
    hasWebhookSecret: !!webhookSecret,
    syncEnabled: await isGitHubSyncEnabled()
  });
});

app.get("/api/github/app/manifest/start", async (req, res) => {
  const projectId = String(req.query.projectId ?? "").trim();
  if (!projectId) {
    return sendError(res, 400, "projectId is required");
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return sendError(res, 404, "project not found");
  }

  const origin = requestOrigin(req);
  if (!origin) {
    return sendError(res, 400, "unable to resolve public origin");
  }

  const callbackUrl = `${origin}/api/github/app/callback`;
  const webhookUrl = `${origin}/api/github/webhooks`;
  const projectUrl = `${origin}/projects/${encodeURIComponent(project.id)}`;
  const appNameBase = `Attractor ${project.name}`.trim();
  const appName = appNameBase.slice(0, 34) || "Attractor Factory";

  res.json({
    manifestUrl: GITHUB_APP_MANIFEST_URL,
    state: project.id,
    manifest: {
      name: appName,
      url: projectUrl,
      hook_attributes: {
        url: webhookUrl
      },
      redirect_url: callbackUrl,
      callback_urls: [callbackUrl],
      public: false,
      default_permissions: {
        metadata: "read",
        contents: "write",
        issues: "read",
        pull_requests: "write",
        checks: "write"
      },
      default_events: [
        "issues",
        "pull_request",
        "issue_comment",
        "pull_request_review",
        "pull_request_review_comment"
      ]
    }
  });
});

app.get("/api/github/app/start", async (req, res) => {
  const projectId = String(req.query.projectId ?? "").trim();
  const credentials = await resolveGitHubAppCredentials();
  const slug = credentials?.appSlug ?? process.env.GITHUB_APP_SLUG?.trim() ?? "";
  if (!slug) {
    return sendError(
      res,
      409,
      "GitHub App slug is not configured. Create the app first via /api/github/app/manifest/start"
    );
  }

  const state = encodeURIComponent(projectId || "none");
  const installationUrl = `https://github.com/apps/${slug}/installations/new?state=${state}`;
  res.json({ installationUrl, appSlug: slug });
});

app.get("/api/github/app/callback", async (req, res) => {
  const installationId = String(req.query.installation_id ?? "").trim();
  const projectId = parseGitHubProjectState(String(req.query.state ?? ""));
  const code = String(req.query.code ?? "").trim();

  if (code) {
    if (!projectId) {
      return sendError(res, 400, "state(projectId) is required for app manifest conversion");
    }

    try {
      const conversion = await convertGitHubManifestCode(code);
      await upsertGitHubAppGlobalSecret(conversion);
      const installationUrl = `https://github.com/apps/${conversion.appSlug}/installations/new?state=${encodeURIComponent(projectId)}`;
      return res.redirect(302, installationUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.redirect(302, buildProjectRedirectUrl(projectId, { githubAppError: message }));
    }
  }

  if (!installationId || !projectId) {
    return sendError(res, 400, "code or installation_id + state(projectId) are required");
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return sendError(res, 404, "project not found");
  }

  await prisma.project.update({
    where: { id: projectId },
    data: {
      githubInstallationId: installationId
    }
  });

  return res.redirect(
    302,
    buildProjectRedirectUrl(project.id, {
      githubLinked: "1",
      installationId
    })
  );
});

app.get("/api/projects/:projectId/github/repos", async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (!project || !project.githubInstallationId) {
    return sendError(res, 404, "project/github installation not found");
  }

  try {
    const octokit = await getInstallationOctokit(project.githubInstallationId);
    const response = await octokit.request("GET /installation/repositories");
    const repos = response.data.repositories
      .map((repo: { id: number; full_name: string; default_branch: string; private: boolean }) => ({
        id: repo.id,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
        private: repo.private
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));

    res.json({ repos, installationId: project.githubInstallationId });
  } catch (error) {
    return sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
});

const server = createServer(app);
const shellWebSocketServer = new WebSocketServer({ noServer: true });

function sendShellSocketMessage(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

class ShellStdoutStream extends Writable {
  columns = 120;
  rows = 40;
  constructor(private readonly onData: (chunk: Buffer) => void) {
    super();
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  setSize(cols: number, rows: number): void {
    this.columns = cols;
    this.rows = rows;
    this.emit("resize");
  }
}

shellWebSocketServer.on("connection", async (ws: WebSocket) => {
  const sessionId = (ws as unknown as { shellSessionId?: string }).shellSessionId ?? "";
  const session = environmentShellSessions.get(sessionId);
  if (!session) {
    ws.close(1008, "session not found");
    return;
  }
  if (session.connected) {
    ws.close(1008, "session already connected");
    return;
  }

  const kubeConfig = loadKubeConfig();
  if (!kubeConfig) {
    ws.close(1011, "kubernetes unavailable");
    return;
  }

  session.connected = true;
  session.clientSocket = ws;
  const stdin = new PassThrough();
  session.stdin = stdin;

  const exec = new Exec(kubeConfig);
  const stdout = new ShellStdoutStream((chunk) => {
    sendShellSocketMessage(ws, {
      type: "output",
      stream: "stdout",
      data: chunk.toString("utf8")
    });
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      sendShellSocketMessage(ws, {
        type: "output",
        stream: "stderr",
        data: Buffer.from(chunk).toString("utf8")
      });
      callback();
    }
  });

  sendShellSocketMessage(ws, { type: "status", state: "connecting" });
  try {
    const execSocket = await exec.exec(
      session.namespace,
      session.podName,
      "shell",
      ["/bin/sh"],
      stdout,
      stderr,
      stdin,
      true,
      (status) => {
        sendShellSocketMessage(ws, { type: "exit", status });
        void terminateEnvironmentShellSession(session.id, { closeClient: false });
      }
    );
    session.execSocket = execSocket as unknown as { close: () => void };
    sendShellSocketMessage(ws, { type: "status", state: "ready" });
  } catch (error) {
    sendShellSocketMessage(ws, {
      type: "error",
      message: error instanceof Error ? error.message : String(error)
    });
    ws.close(1011, "exec failed");
    void terminateEnvironmentShellSession(session.id, { closeClient: false });
    return;
  }

  ws.on("message", (raw: RawData) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const message = parsed as Record<string, unknown>;
    if (message.type === "input" && typeof message.data === "string") {
      stdin.write(message.data);
      return;
    }
    if (message.type === "resize") {
      const cols = Number(message.cols);
      const rows = Number(message.rows);
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
        stdout.setSize(cols, rows);
      }
      return;
    }
    if (message.type === "terminate") {
      ws.close(1000, "terminated");
    }
  });

  ws.on("close", () => {
    void terminateEnvironmentShellSession(session.id, { closeClient: false });
  });
  ws.on("error", () => {
    void terminateEnvironmentShellSession(session.id, { closeClient: false });
  });
});

server.on("upgrade", (request, socket, head) => {
  let parsedPath: { sessionId: string } | null = null;
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    parsedPath = parseShellStreamPath(url.pathname);
  } catch {
    parsedPath = null;
  }
  if (!parsedPath) {
    socket.destroy();
    return;
  }
  if (authConfig.enabled) {
    const cookies = parseCookieHeader(request.headers.cookie);
    const session = readSessionToken(authConfig, cookies[FACTORY_AUTH_SESSION_COOKIE_NAME]);
    if (!session) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"authentication required\"}"
      );
      socket.destroy();
      return;
    }
  }

  shellWebSocketServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
    (ws as unknown as { shellSessionId: string }).shellSessionId = parsedPath?.sessionId ?? "";
    shellWebSocketServer.emit("connection", ws, request);
  });
});

let reconcileLoopActive = false;
function startGitHubReconcileLoop() {
  const explicit = process.env.GITHUB_SYNC_ENABLED?.trim().toLowerCase();
  if (explicit === "false") {
    process.stdout.write("github sync scheduler disabled (GITHUB_SYNC_ENABLED=false)\n");
    return;
  }

  const intervalMs = githubSyncConfig.reconcileIntervalMinutes * 60 * 1000;
  process.stdout.write(`github sync scheduler interval ${githubSyncConfig.reconcileIntervalMinutes}m\n`);
  setInterval(() => {
    if (reconcileLoopActive) {
      return;
    }
    reconcileLoopActive = true;
    void (async () => {
      try {
        if (!(await isGitHubSyncEnabled())) {
          return;
        }
        const projects = await prisma.project.findMany({
          where: {
            githubInstallationId: { not: null },
            repoFullName: { not: null }
          },
          select: { id: true }
        });
        for (const project of projects) {
          try {
            const result = await reconcileProjectGitHub(project.id);
            process.stdout.write(
              `github reconcile project=${project.id} issues=${result.issuesSynced} pulls=${result.pullRequestsSynced}\n`
            );
          } catch (error) {
            process.stderr.write(
              `github reconcile failed project=${project.id}: ${error instanceof Error ? error.message : String(error)}\n`
            );
          }
        }
      } finally {
        reconcileLoopActive = false;
      }
    })();
  }, intervalMs);
}

let taskTemplateSchedulerLoopActive = false;
async function processScheduledTaskTemplates(): Promise<void> {
  const now = new Date();
  const dueCandidates = await prisma.taskTemplate.findMany({
    where: {
      active: true,
      scheduleEnabled: true,
      scheduleNextRunAt: { lte: now }
    },
    orderBy: [{ scheduleNextRunAt: "asc" }],
    take: TASK_TEMPLATE_SCHEDULER_BATCH_SIZE * 4
  });
  if (dueCandidates.length === 0) {
    return;
  }

  const globalCandidates = dueCandidates.filter((template) => template.scope === AttractorScope.GLOBAL);
  const overrideProjectIds = [...new Set(globalCandidates.map((template) => template.projectId))];
  const overrideNames = [...new Set(globalCandidates.map((template) => template.name))];

  let overrideSet = new Set<string>();
  if (overrideProjectIds.length > 0 && overrideNames.length > 0) {
    const overrides = await prisma.taskTemplate.findMany({
      where: {
        scope: AttractorScope.PROJECT,
        projectId: { in: overrideProjectIds },
        name: { in: overrideNames }
      },
      select: {
        projectId: true,
        name: true
      }
    });
    overrideSet = new Set(overrides.map((item) => `${item.projectId}:${item.name}`));
  }

  const effective = dueCandidates.filter((template) => {
    if (template.scope !== AttractorScope.GLOBAL) {
      return true;
    }
    return !overrideSet.has(`${template.projectId}:${template.name}`);
  });
  effective.sort((a, b) => {
    const left = a.scheduleNextRunAt?.getTime() ?? 0;
    const right = b.scheduleNextRunAt?.getTime() ?? 0;
    return left - right;
  });

  for (const template of effective.slice(0, TASK_TEMPLATE_SCHEDULER_BATCH_SIZE)) {
    const timezone = (template.scheduleTimezone ?? "").trim() || "UTC";
    const cron = (template.scheduleCron ?? "").trim();
    const fallbackNext = new Date(Date.now() + TASK_TEMPLATE_SCHEDULER_INTERVAL_SECONDS * 1000);
    let nextRunAt: Date | null = null;
    if (cron && isValidIanaTimeZone(timezone)) {
      try {
        nextRunAt = nextCronDate({
          cron,
          timeZone: timezone,
          from: now
        });
      } catch {
        nextRunAt = fallbackNext;
      }
    } else {
      nextRunAt = fallbackNext;
    }

    try {
      const queued = await queueRunFromTaskTemplate({
        projectId: template.projectId,
        taskTemplateId: template.id,
        taskTemplateName: template.name,
        attractorName: template.attractorName,
        runType: template.runType,
        sourceBranch: template.sourceBranch,
        targetBranch: template.targetBranch,
        environmentMode: template.environmentMode,
        environmentName: template.environmentName,
        launchMode: TaskTemplateLaunchMode.SCHEDULE
      });
      await prisma.taskTemplate.update({
        where: { id: template.id },
        data: {
          scheduleLastRunAt: now,
          scheduleLastError: null,
          scheduleNextRunAt: nextRunAt
        }
      });
      process.stdout.write(
        `task template scheduled project=${template.projectId} template=${template.id} run=${queued.runId}\n`
      );
    } catch (error) {
      await prisma.taskTemplate.update({
        where: { id: template.id },
        data: {
          scheduleLastError: error instanceof Error ? error.message : String(error),
          scheduleNextRunAt: nextRunAt
        }
      });
      process.stderr.write(
        `task template schedule failed template=${template.id}: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    }
  }
}

function startTaskTemplateSchedulerLoop() {
  if (!TASK_TEMPLATE_SCHEDULER_ENABLED) {
    process.stdout.write("task template scheduler disabled (TASK_TEMPLATE_SCHEDULER_ENABLED=false)\n");
    return;
  }

  process.stdout.write(
    `task template scheduler interval ${TASK_TEMPLATE_SCHEDULER_INTERVAL_SECONDS}s batch=${TASK_TEMPLATE_SCHEDULER_BATCH_SIZE}\n`
  );
  const intervalMs = TASK_TEMPLATE_SCHEDULER_INTERVAL_SECONDS * 1000;
  const lockKey = "task-templates:scheduler:leader";
  const lockTtlSeconds = Math.max(5, TASK_TEMPLATE_SCHEDULER_INTERVAL_SECONDS - 1);
  setInterval(() => {
    if (taskTemplateSchedulerLoopActive) {
      return;
    }
    taskTemplateSchedulerLoopActive = true;
    void (async () => {
      try {
        const lock = await redis.set(lockKey, "1", "EX", lockTtlSeconds, "NX");
        if (lock !== "OK") {
          return;
        }
        await processScheduledTaskTemplates();
      } finally {
        taskTemplateSchedulerLoopActive = false;
      }
    })();
  }, intervalMs);
}

server.listen(PORT, HOST, () => {
  process.stdout.write(`factory-api listening on http://${HOST}:${PORT}\n`);
  startGitHubReconcileLoop();
  startTaskTemplateSchedulerLoop();
});
