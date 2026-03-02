import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand
} from "@aws-sdk/client-s3";
import { App as GitHubApp } from "@octokit/app";
import { PrismaClient, RunQuestionStatus, RunStatus, RunType } from "@prisma/client";
import { Redis } from "ioredis";
import {
  getModel,
  getModels,
  getProviders,
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type ToolCall
} from "@mariozechner/pi-ai";
import {
  runCancelKey,
  runEventChannel,
  runLockKey,
  attractorUsesDotImplementation,
  type RunModelConfig,
  type RunExecutionEnvironment,
  type RunExecutionSpec
} from "@attractor/shared-types";
import { extractUnifiedDiff } from "./patch.js";
import {
  applyGraphTransforms,
  executeGraph,
  parseDotGraph,
  parseModelStylesheet,
  validateDotGraph,
  type DotGraph,
  type DotNode,
  type EngineState
} from "./engine/index.js";
import { executeToolNode, type RunCommandOptions } from "./tool-node.js";

const execFileAsync = promisify(execFile);

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");

const minioClient = new S3Client({
  region: "us-east-1",
  endpoint: process.env.MINIO_ENDPOINT ?? "http://minio:9000",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY ?? "minioadmin",
    secretAccessKey: process.env.MINIO_SECRET_KEY ?? "minioadmin"
  }
});
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "factory-artifacts";
const SETUP_SCRIPT_OUTPUT_LIMIT = Number(process.env.SETUP_SCRIPT_OUTPUT_LIMIT ?? 12000);

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

function parseSpec(): RunExecutionSpec {
  const raw = process.env.RUN_EXECUTION_SPEC;
  if (!raw) {
    throw new Error("RUN_EXECUTION_SPEC is required");
  }

  return JSON.parse(raw) as RunExecutionSpec;
}

function parseEnvironmentSpec(spec: RunExecutionSpec): RunExecutionEnvironment {
  if (spec.environment) {
    return spec.environment;
  }

  const raw = process.env.RUN_ENVIRONMENT_SPEC;
  if (raw) {
    return JSON.parse(raw) as RunExecutionEnvironment;
  }

  return {
    id: "legacy-default",
    name: "legacy-default",
    kind: "KUBERNETES_JOB",
    runnerImage: process.env.RUNNER_IMAGE ?? "ghcr.io/wcraigjones/attractor-factory-runner:latest",
    serviceAccountName: process.env.RUNNER_SERVICE_ACCOUNT ?? "factory-runner"
  };
}

function modelExists(config: Pick<RunModelConfig, "provider" | "modelId">): boolean {
  if (!getProviders().includes(config.provider as never)) {
    return false;
  }
  return getModels(config.provider as never).some((model) => model.id === config.modelId);
}

function resolveModelConfig(config: RunModelConfig): {
  resolved: RunModelConfig;
  fallback?: { fromModelId: string; toModelId: string; reason: string };
} {
  if (modelExists(config)) {
    return { resolved: config };
  }

  if (config.provider === "openrouter" && config.modelId === "openai/gpt-5.3-codex") {
    const fallbackModel = "openai/gpt-5.2-codex";
    if (modelExists({ provider: "openrouter", modelId: fallbackModel })) {
      return {
        resolved: { ...config, modelId: fallbackModel },
        fallback: {
          fromModelId: config.modelId,
          toModelId: fallbackModel,
          reason: "openai/gpt-5.3-codex not present in runtime model catalog"
        }
      };
    }
  }

  throw new Error(`Unknown model ${config.modelId} for provider ${config.provider}`);
}

function ensureModel(config: RunModelConfig) {
  if (!getProviders().includes(config.provider as never)) {
    throw new Error(`Unknown provider ${config.provider}`);
  }
  const model = getModel(config.provider as never, config.modelId as never);
  if (!model) {
    throw new Error(`Unknown model ${config.modelId} for provider ${config.provider}`);
  }
  return model;
}

function toStreamEvent(event: AssistantMessageEvent): { type: string; payload: unknown } | null {
  if (event.type === "text_delta") {
    return { type: "text_delta", payload: { delta: event.delta } };
  }
  if (event.type === "thinking_delta") {
    return { type: "thinking_delta", payload: { delta: event.delta } };
  }
  if (event.type === "toolcall_start") {
    return { type: "toolcall_start", payload: { contentIndex: event.contentIndex } };
  }
  if (event.type === "toolcall_delta") {
    return {
      type: "toolcall_delta",
      payload: { contentIndex: event.contentIndex, delta: event.delta }
    };
  }
  if (event.type === "toolcall_end") {
    return {
      type: "toolcall_end",
      payload: {
        contentIndex: event.contentIndex,
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.name
      }
    };
  }
  if (event.type === "done") {
    return { type: "done", payload: { reason: event.reason } };
  }
  if (event.type === "error") {
    return {
      type: "error",
      payload: { reason: event.reason, error: event.error.errorMessage ?? "LLM error" }
    };
  }
  return null;
}

function textFromMessage(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function runCodergen(
  prompt: string,
  runId: string,
  modelConfig: RunModelConfig,
  eventNamespace = "Model"
): Promise<{ text: string; modelConfig: RunModelConfig; fallback?: { fromModelId: string; toModelId: string; reason: string } }> {
  const resolved = resolveModelConfig(modelConfig);
  const model = ensureModel(resolved.resolved);
  const context: Context = {
    messages: [
      {
        role: "user",
        content: prompt,
        timestamp: Date.now()
      }
    ]
  };

  const maxRounds = 8;
  for (let round = 1; round <= maxRounds; round += 1) {
    const stream = streamSimple(model, context, {
      ...(resolved.resolved.reasoningLevel ? { reasoning: resolved.resolved.reasoningLevel } : {}),
      ...(resolved.resolved.temperature !== undefined
        ? { temperature: resolved.resolved.temperature }
        : {}),
      ...(resolved.resolved.maxTokens !== undefined ? { maxTokens: resolved.resolved.maxTokens } : {})
    });

    for await (const event of stream) {
      const mapped = toStreamEvent(event);
      if (mapped) {
        await appendRunEvent(runId, `${eventNamespace}${mapped.type}`, { round, payload: mapped.payload });
      }
    }

    const message = await stream.result();
    context.messages.push(message);

    const toolCalls = message.content.filter(
      (block): block is ToolCall => block.type === "toolCall"
    );

    if (toolCalls.length === 0) {
      return { text: textFromMessage(message), modelConfig: resolved.resolved, ...(resolved.fallback ? { fallback: resolved.fallback } : {}) };
    }

    for (const toolCall of toolCalls) {
      context.messages.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text: `No external tools are configured yet in factory-runner. Tool ${toolCall.name} was skipped.`
          }
        ],
        isError: true,
        timestamp: Date.now()
      });
    }
  }

  throw new Error(`Model loop exceeded ${maxRounds} rounds`);
}

const SNAPSHOT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache"
]);

const SNAPSHOT_MAX_FILES = 200;
const SNAPSHOT_MAX_TOTAL_CHARS = 220_000;
const SNAPSHOT_MAX_FILE_CHARS = 8_000;
const SNAPSHOT_MAX_FILE_SIZE_BYTES = 256_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseOptionalFloat(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseReasoningLevel(
  value: string | undefined
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

function isProbablyBinary(content: Buffer): boolean {
  const length = Math.min(content.length, 1024);
  for (let index = 0; index < length; index += 1) {
    if (content[index] === 0) {
      return true;
    }
  }
  return false;
}

function shouldIgnoreSnapshotPath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  return parts.some((part) => SNAPSHOT_IGNORED_DIRS.has(part));
}

function listRepositoryFiles(rootDir: string, relDir = ""): string[] {
  const absoluteDir = relDir ? join(rootDir, relDir) : rootDir;
  const entries = readdirSync(absoluteDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];

  for (const entry of entries) {
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (shouldIgnoreSnapshotPath(relPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...listRepositoryFiles(rootDir, relPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(relPath);
    }
  }

  return files;
}

function buildRepositorySnapshot(rootDir: string): {
  tree: string;
  content: string;
  filesIncluded: number;
  truncated: boolean;
} {
  const files = listRepositoryFiles(rootDir);
  const tree = files.length > 0 ? files.join("\n") : "(no files found)";

  const sections: string[] = [];
  let totalChars = 0;
  let filesIncluded = 0;
  let truncated = false;

  for (const filePath of files) {
    if (filesIncluded >= SNAPSHOT_MAX_FILES) {
      truncated = true;
      break;
    }

    const absolutePath = join(rootDir, filePath);
    const size = statSync(absolutePath).size;
    if (size > SNAPSHOT_MAX_FILE_SIZE_BYTES) {
      continue;
    }

    const raw = readFileSync(absolutePath);
    if (isProbablyBinary(raw)) {
      continue;
    }

    const text = raw.toString("utf8");
    const clipped = text.slice(0, SNAPSHOT_MAX_FILE_CHARS);
    const section = [
      `### ${filePath}`,
      "```",
      clipped,
      "```"
    ].join("\n");

    if (totalChars + section.length > SNAPSHOT_MAX_TOTAL_CHARS) {
      truncated = true;
      break;
    }

    sections.push(section);
    totalChars += section.length;
    filesIncluded += 1;
    if (clipped.length < text.length) {
      truncated = true;
    }
  }

  const content = [
    "## Repository Tree",
    "```text",
    tree,
    "```",
    "",
    "## Repository Content Snapshot",
    sections.join("\n\n"),
    truncated
      ? "\n[Snapshot truncated to fit execution limits]"
      : ""
  ]
    .filter((part) => part.length > 0)
    .join("\n");

  return {
    tree,
    content,
    filesIncluded,
    truncated
  };
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => typeof item === "string")
      .map(([key, item]) => [key, item as string])
  );
}

function nestedStringMap(value: unknown): Record<string, Record<string, string>> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, stringMap(item)])
  );
}

function normalizeEngineState(value: unknown): EngineState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const payload = value as Record<string, unknown>;
  return {
    context:
      payload.context && typeof payload.context === "object"
        ? (payload.context as Record<string, unknown>)
        : {},
    nodeOutputs: stringMap(payload.nodeOutputs),
    parallelOutputs: nestedStringMap(payload.parallelOutputs),
    nodeOutcomes: {},
    nodeRetryCounts: {},
    completedNodes:
      Array.isArray(payload.completedNodes) &&
      payload.completedNodes.every((item) => typeof item === "string")
        ? (payload.completedNodes as string[])
        : []
  };
}

function answerText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
}

function nodeModelConfig(defaultConfig: RunModelConfig, node: DotNode): RunModelConfig {
  const reasoningLevel =
    parseReasoningLevel(node.attrs.reasoning ?? node.attrs.reasoning_level) ??
    defaultConfig.reasoningLevel;
  const temperature = parseOptionalFloat(node.attrs.temperature) ?? defaultConfig.temperature;
  const maxTokens =
    parseOptionalInt(node.attrs.max_tokens ?? node.attrs.maxTokens) ?? defaultConfig.maxTokens;

  return {
    provider: node.attrs.provider ?? defaultConfig.provider,
    modelId: node.attrs.model ?? node.attrs.model_id ?? defaultConfig.modelId,
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {})
  };
}

function renderTaskReport(args: {
  output: string;
  runId: string;
  repoFullName: string;
  sourceBranch: string;
  exitNodeId: string;
  finalNodeId: string | null;
  modelResolutions: Array<{
    nodeId: string;
    requested: RunModelConfig;
    resolved: RunModelConfig;
    fallback?: { fromModelId: string; toModelId: string; reason: string };
  }>;
}): string {
  const metadata = {
    runId: args.runId,
    repository: args.repoFullName,
    sourceBranch: args.sourceBranch,
    exitNodeId: args.exitNodeId,
    finalNodeId: args.finalNodeId,
    generatedAt: new Date().toISOString(),
    modelResolutions: args.modelResolutions
  };

  const body = args.output.trim().length > 0 ? args.output.trim() : "_No report content generated._";
  return `<!--\n${JSON.stringify(metadata, null, 2)}\n-->\n\n${body}\n`;
}

async function ensureBucketExists(): Promise<void> {
  try {
    await minioClient.send(new HeadBucketCommand({ Bucket: MINIO_BUCKET }));
    return;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const name = (error as { name?: string })?.name;
    if (status === 404 || name === "NotFound" || name === "NoSuchBucket") {
      await minioClient.send(new CreateBucketCommand({ Bucket: MINIO_BUCKET }));
      return;
    }
    throw error;
  }
}

async function putObject(key: string, content: string, contentType = "text/plain"): Promise<void> {
  await minioClient.send(
    new PutObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: key,
      Body: content,
      ContentType: contentType
    })
  );
}

async function getObjectString(key: string): Promise<string> {
  const output = await minioClient.send(new GetObjectCommand({ Bucket: MINIO_BUCKET, Key: key }));
  if (!output.Body) {
    throw new Error(`Object ${key} has no body`);
  }

  const body = output.Body as { transformToString?: () => Promise<string> };
  if (body.transformToString) {
    return body.transformToString();
  }

  throw new Error("Unsupported S3 body stream implementation");
}

function gitRemote(repoFullName: string, token?: string | null): string {
  if (!token) {
    return `https://github.com/${repoFullName}.git`;
  }
  return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
}

async function githubGitToken(installationId?: string): Promise<string | null> {
  const staticToken = process.env.GITHUB_TOKEN?.trim() ?? "";
  if (staticToken) {
    return staticToken;
  }
  if (!installationId) {
    return null;
  }

  const app = githubApp();
  if (!app) {
    return null;
  }

  try {
    const octokit = await app.getInstallationOctokit(Number(installationId));
    const auth = (await octokit.auth({ type: "installation" } as never)) as
      | string
      | { token?: unknown }
      | null
      | undefined;
    if (typeof auth === "string") {
      const token = auth.trim();
      return token.length > 0 ? token : null;
    }
    const token = String(auth?.token ?? "").trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    process.stderr.write(
      `failed to resolve installation token for ${installationId}: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return null;
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  options: RunCommandOptions = {}
): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd,
    timeout: options.timeoutMs,
    maxBuffer: 10 * 1024 * 1024
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function normalizeCommandOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

function commandOutputFromError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const payload = error as { stdout?: unknown; stderr?: unknown };
  return `${normalizeCommandOutput(payload.stdout)}${normalizeCommandOutput(payload.stderr)}`;
}

function trimOutputTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

async function runEnvironmentSetupScript(args: {
  runId: string;
  workDir: string;
  environment: RunExecutionEnvironment;
}): Promise<void> {
  const setupScript = args.environment.setupScript?.trim();
  if (!setupScript) {
    return;
  }

  const startedAt = Date.now();
  await appendRunEvent(args.runId, "EnvironmentSetupStarted", {
    runId: args.runId,
    environmentId: args.environment.id,
    environmentName: args.environment.name
  });

  try {
    const output = await runCommand("bash", ["-lc", setupScript], args.workDir);
    await appendRunEvent(args.runId, "EnvironmentSetupCompleted", {
      runId: args.runId,
      durationMs: Date.now() - startedAt,
      outputTail: trimOutputTail(output, SETUP_SCRIPT_OUTPUT_LIMIT)
    });
  } catch (error) {
    const output = commandOutputFromError(error);
    await appendRunEvent(args.runId, "EnvironmentSetupFailed", {
      runId: args.runId,
      durationMs: Date.now() - startedAt,
      outputTail: trimOutputTail(output, SETUP_SCRIPT_OUTPUT_LIMIT),
      message: error instanceof Error ? error.message : String(error)
    });
    throw new Error(
      `Environment setup script failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function configureRepositoryGitIdentity(cwd: string): Promise<void> {
  const authorName = (process.env.RUN_GIT_AUTHOR_NAME ?? "Attractor Factory Bot").trim();
  const authorEmail = (process.env.RUN_GIT_AUTHOR_EMAIL ?? "factory-bot@attractor.local").trim();
  await runCommand("git", ["config", "user.name", authorName], cwd);
  await runCommand("git", ["config", "user.email", authorEmail], cwd);
}

async function hasStagedChanges(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["diff", "--cached", "--quiet"], { cwd });
    return false;
  } catch (error) {
    const code = (error as { code?: number | string })?.code;
    if (code === 1 || code === "1") {
      return true;
    }
    throw error;
  }
}

async function checkoutRepository(
  runId: string,
  repoFullName: string,
  sourceBranch: string,
  installationId?: string
): Promise<string> {
  const workDir = mkdtempSync(join(tmpdir(), `factory-run-${runId}-`));
  const token = await githubGitToken(installationId);
  await runCommand(
    "git",
    ["clone", "--depth", "1", "--branch", sourceBranch, gitRemote(repoFullName, token), workDir],
    tmpdir()
  );
  await configureRepositoryGitIdentity(workDir);
  return workDir;
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function loadAttractorContent(args: {
  workDir: string;
  snapshot: {
    contentPath: string | null;
    contentVersion: number | null;
    contentSha256: string | null;
  };
  attractor: {
    name: string;
    repoPath: string | null;
    contentPath: string | null;
    contentVersion: number;
  };
}): Promise<{ content: string; source: "snapshot" | "storage" | "repo"; path: string }> {
  if (args.snapshot.contentPath) {
    try {
      const content = await getObjectString(args.snapshot.contentPath);
      if (args.snapshot.contentSha256) {
        const actualDigest = digestText(content);
        if (actualDigest !== args.snapshot.contentSha256) {
          throw new Error(
            `Attractor snapshot hash mismatch: expected ${args.snapshot.contentSha256}, got ${actualDigest}`
          );
        }
      }
      return {
        content,
        source: "snapshot",
        path: args.snapshot.contentPath
      };
    } catch (error) {
      throw new Error(
        `Failed to load attractor snapshot from ${args.snapshot.contentPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (args.attractor.contentPath) {
    try {
      const content = await getObjectString(args.attractor.contentPath);
      return {
        content,
        source: "storage",
        path: args.attractor.contentPath
      };
    } catch (error) {
      if (!args.attractor.repoPath) {
        throw new Error(
          `Failed to load attractor ${args.attractor.name} content from storage path ${args.attractor.contentPath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  if (!args.attractor.repoPath) {
    throw new Error(
      `Attractor ${args.attractor.name} has no storage content and no legacy repoPath configured`
    );
  }

  const absolutePath = join(args.workDir, args.attractor.repoPath);
  return {
    content: readFileSync(absolutePath, "utf8"),
    source: "repo",
    path: args.attractor.repoPath
  };
}

async function createSpecBundle(runId: string, projectId: string, sourceBranch: string, repo: string, planText: string): Promise<{ specBundleId: string; manifestPath: string }> {
  const schemaVersion = "v1";
  const prefix = `spec-bundles/${projectId}/${runId}`;

  const files: Array<{ name: string; content: string; contentType: string }> = [
    { name: "plan.md", content: planText, contentType: "text/markdown" },
    {
      name: "requirements.md",
      content: `# Requirements\n\nGenerated by planning run ${runId}.`,
      contentType: "text/markdown"
    },
    {
      name: "tasks.json",
      content: JSON.stringify({ tasks: [{ id: "task-1", title: "Implement planned changes" }] }, null, 2),
      contentType: "application/json"
    },
    {
      name: "acceptance-tests.md",
      content: "# Acceptance Tests\n\n- Validate generated implementation.",
      contentType: "text/markdown"
    }
  ];

  const artifacts = files.map(({ name }) => ({
    name,
    path: `${prefix}/${name}`
  }));

  const manifest = {
    schema_version: schemaVersion,
    project_id: projectId,
    source_run_id: runId,
    repo,
    source_branch: sourceBranch,
    created_at: new Date().toISOString(),
    artifacts,
    checksums: {}
  };

  for (const file of files) {
    await putObject(`${prefix}/${file.name}`, file.content, file.contentType);
  }

  const manifestPath = `${prefix}/manifest.json`;
  await putObject(manifestPath, JSON.stringify(manifest, null, 2), "application/json");

  const specBundle = await prisma.specBundle.create({
    data: {
      runId,
      schemaVersion,
      manifestPath
    }
  });

  await prisma.artifact.createMany({
    data: files.map((file) => ({
      runId,
      key: file.name,
      path: `${prefix}/${file.name}`,
      contentType: file.contentType,
      sizeBytes: Buffer.byteLength(file.content, "utf8")
    }))
  });

  return {
    specBundleId: specBundle.id,
    manifestPath
  };
}

function githubApp(): GitHubApp | null {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    return null;
  }

  return new GitHubApp({ appId, privateKey: privateKey.replace(/\\n/g, "\n") });
}

async function createPullRequest(args: {
  installationId?: string;
  repoFullName: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
}): Promise<{ url: string | null; number: number | null; headSha: string | null }> {
  const [owner, repo] = args.repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repoFullName: ${args.repoFullName}`);
  }

  if (args.installationId) {
    const app = githubApp();
    if (app) {
      const octokit = await app.getInstallationOctokit(Number(args.installationId));
      const pr = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        base: args.baseBranch,
        head: args.headBranch,
        title: args.title,
        body: args.body
      });
      return {
        url: pr.data.html_url ?? null,
        number: pr.data.number ?? null,
        headSha: pr.data.head?.sha ?? null
      };
    }
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { url: null, number: null, headSha: null };
  }

  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit({ auth: token });
  const pr = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    base: args.baseBranch,
    head: args.headBranch,
    title: args.title,
    body: args.body
  });
  return {
    url: pr.data.html_url ?? null,
    number: pr.data.number ?? null,
    headSha: pr.data.head?.sha ?? null
  };
}

async function assertRunNotCanceled(runId: string): Promise<void> {
  const canceled = await redis.get(runCancelKey(runId));
  if (canceled) {
    throw new Error("Run canceled during execution");
  }
}

async function waitForHumanQuestion(args: {
  runId: string;
  nodeId: string;
  prompt: string;
  options?: string[];
  timeoutMs?: number;
}): Promise<string> {
  const existingPending = await prisma.runQuestion.findFirst({
    where: {
      runId: args.runId,
      nodeId: args.nodeId,
      prompt: args.prompt,
      status: RunQuestionStatus.PENDING
    },
    orderBy: { createdAt: "desc" }
  });

  if (!existingPending) {
    const existingAnswered = await prisma.runQuestion.findFirst({
      where: {
        runId: args.runId,
        nodeId: args.nodeId,
        prompt: args.prompt,
        status: RunQuestionStatus.ANSWERED
      },
      orderBy: { answeredAt: "desc" }
    });
    if (existingAnswered) {
      const text = answerText(existingAnswered.answer);
      if (text.trim().length > 0) {
        return text;
      }
    }
  }

  const question =
    existingPending ??
    (await prisma.runQuestion.create({
      data: {
        runId: args.runId,
        nodeId: args.nodeId,
        prompt: args.prompt,
        options: args.options as never
      }
    }));

  await appendRunEvent(args.runId, "HumanQuestionPending", {
    runId: args.runId,
    questionId: question.id,
    nodeId: args.nodeId,
    prompt: args.prompt,
    hasOptions: Boolean(args.options && args.options.length > 0),
    timeoutMs: args.timeoutMs ?? null
  });

  const deadline = args.timeoutMs ? Date.now() + args.timeoutMs : null;
  while (true) {
    await assertRunNotCanceled(args.runId);

    const current = await prisma.runQuestion.findUnique({
      where: { id: question.id }
    });
    if (!current) {
      throw new Error(`Question ${question.id} no longer exists`);
    }

    if (current.status === RunQuestionStatus.ANSWERED) {
      const text = answerText(current.answer);
      if (text.trim().length === 0) {
        throw new Error(`Question ${question.id} has an empty answer`);
      }
      await appendRunEvent(args.runId, "HumanQuestionAnswered", {
        runId: args.runId,
        questionId: question.id,
        nodeId: args.nodeId
      });
      return text;
    }

    if (current.status === RunQuestionStatus.TIMEOUT) {
      throw new Error(`Question ${question.id} timed out`);
    }

    if (deadline && Date.now() > deadline) {
      await prisma.runQuestion.updateMany({
        where: {
          id: question.id,
          status: RunQuestionStatus.PENDING
        },
        data: {
          status: RunQuestionStatus.TIMEOUT
        }
      });
      await appendRunEvent(args.runId, "HumanQuestionTimedOut", {
        runId: args.runId,
        questionId: question.id,
        nodeId: args.nodeId,
        timeoutMs: args.timeoutMs
      });
      throw new Error(`Question ${question.id} timed out`);
    }

    await sleep(2000);
  }
}

function selectFinalOutputNodeId(graph: ReturnType<typeof parseDotGraph>, state: EngineState): string | null {
  const preferredIds = [
    graph.graphAttrs.final_output_node,
    graph.graphAttrs.finalOutputNode,
    graph.graphAttrs.synthesis_node,
    graph.graphAttrs.synthesisNode
  ]
    .map((item) => item?.trim() ?? "")
    .filter((item) => item.length > 0);

  for (const nodeId of preferredIds) {
    if (state.nodeOutputs[nodeId] && state.nodeOutputs[nodeId].trim().length > 0) {
      return nodeId;
    }
  }

  for (let index = graph.nodeOrder.length - 1; index >= 0; index -= 1) {
    const nodeId = graph.nodeOrder[index] ?? "";
    const output = state.nodeOutputs[nodeId];
    if (output && output.trim().length > 0) {
      return nodeId;
    }
  }

  return null;
}

function parseArtifactNodeList(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }

  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const parsedValues: string[] = [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") {
            parsedValues.push(item);
          }
        }
      }
    } catch {
      // Ignore and fall back to delimiter-based parsing.
    }
  }

  if (parsedValues.length === 0) {
    parsedValues.push(...trimmed.split(/[\s,;]+/g));
  }

  const uniqueNodeIds: string[] = [];
  const seen = new Set<string>();
  for (const value of parsedValues) {
    const nodeId = value.trim();
    if (nodeId.length === 0 || seen.has(nodeId)) {
      continue;
    }
    seen.add(nodeId);
    uniqueNodeIds.push(nodeId);
  }
  return uniqueNodeIds;
}

function normalizeArtifactKey(rawKey: string, fallback: string): string {
  const trimmed = rawKey.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  const normalized = trimmed
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");

  return normalized.length > 0 ? normalized : fallback;
}

function reviewerArtifactKey(nodeId: string): string {
  const safeStem = nodeId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `reviewers/${safeStem || "reviewer"}.md`;
}

function withUniqueArtifactKey(desiredKey: string, usedKeys: Set<string>): string {
  if (!usedKeys.has(desiredKey)) {
    usedKeys.add(desiredKey);
    return desiredKey;
  }

  const extensionIndex = desiredKey.lastIndexOf(".");
  const hasExtension = extensionIndex > 0 && extensionIndex < desiredKey.length - 1;
  const base = hasExtension ? desiredKey.slice(0, extensionIndex) : desiredKey;
  const extension = hasExtension ? desiredKey.slice(extensionIndex) : "";
  let suffix = 2;
  let candidate = `${base}-${suffix}${extension}`;
  while (usedKeys.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}${extension}`;
  }
  usedKeys.add(candidate);
  return candidate;
}

function resolveParallelBranchName(graph: ReturnType<typeof parseDotGraph>, edgeIndex: number): string | null {
  const edge = graph.edges[edgeIndex];
  if (!edge) {
    return null;
  }

  const labeled = edge.label.trim();
  if (labeled.length > 0) {
    return labeled;
  }

  const outgoingEdges = graph.edges.filter((candidate) => candidate.from === edge.from);
  const branchIndex = outgoingEdges.findIndex((candidate) => candidate === edge);
  if (branchIndex < 0) {
    return null;
  }
  return `branch-${branchIndex + 1}`;
}

function resolveTaskNodeOutput(
  graph: ReturnType<typeof parseDotGraph>,
  state: EngineState,
  nodeId: string
): string {
  const directOutput = state.nodeOutputs[nodeId];
  if (directOutput && directOutput.trim().length > 0) {
    return directOutput;
  }

  for (let edgeIndex = 0; edgeIndex < graph.edges.length; edgeIndex += 1) {
    const edge = graph.edges[edgeIndex];
    if (!edge || edge.to !== nodeId) {
      continue;
    }

    const fromNode = graph.nodes[edge.from];
    if (!fromNode || fromNode.type !== "parallel") {
      continue;
    }

    const branchName = resolveParallelBranchName(graph, edgeIndex);
    if (!branchName) {
      continue;
    }

    const branchOutput = state.parallelOutputs[fromNode.id]?.[branchName];
    if (branchOutput && branchOutput.trim().length > 0) {
      return branchOutput;
    }
  }

  return "";
}

function parseBoolAttr(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function isDotImplementationGraph(graph: DotGraph): boolean {
  const mode = (
    graph.graphAttrs.implementation_mode ??
    graph.graphAttrs.implementationMode ??
    ""
  )
    .trim()
    .toLowerCase();
  if (mode === "dot" || mode === "workflow" || mode === "graph") {
    return true;
  }
  if (
    parseBoolAttr(graph.graphAttrs.implementation_dot ?? graph.graphAttrs.implementationDot)
  ) {
    return true;
  }
  if (
    (graph.graphAttrs.implementation_patch_node ?? graph.graphAttrs.implementationPatchNode)?.trim()
  ) {
    return true;
  }
  return false;
}

function isDotImplementationAttractor(attractorContent: string): boolean {
  if (!attractorUsesDotImplementation(attractorContent)) {
    return false;
  }
  try {
    const parsed = parseDotGraph(attractorContent);
    return isDotImplementationGraph(parsed);
  } catch {
    return false;
  }
}

function firstOutputNodeId(
  graph: DotGraph,
  state: EngineState,
  preferredIds: Array<string | undefined>
): string | null {
  for (const rawId of preferredIds) {
    const nodeId = rawId?.trim() ?? "";
    if (!nodeId) {
      continue;
    }
    const output = resolveTaskNodeOutput(graph, state, nodeId);
    if (output.trim().length > 0) {
      return nodeId;
    }
  }
  return null;
}

function selectImplementationPatchNodeId(graph: DotGraph, state: EngineState): string | null {
  const preferred = [
    graph.graphAttrs.implementation_patch_node,
    graph.graphAttrs.implementationPatchNode,
    graph.graphAttrs.patch_node,
    graph.graphAttrs.patchNode,
    graph.graphAttrs.final_output_node,
    graph.graphAttrs.finalOutputNode
  ];

  const preferredWithOutput = firstOutputNodeId(graph, state, preferred);
  if (preferredWithOutput) {
    const preferredOutput = resolveTaskNodeOutput(graph, state, preferredWithOutput);
    if (extractUnifiedDiff(preferredOutput)) {
      return preferredWithOutput;
    }
  }

  for (let index = graph.nodeOrder.length - 1; index >= 0; index -= 1) {
    const nodeId = graph.nodeOrder[index] ?? "";
    const output = resolveTaskNodeOutput(graph, state, nodeId);
    if (!output || output.trim().length === 0) {
      continue;
    }
    if (extractUnifiedDiff(output)) {
      return nodeId;
    }
  }

  return preferredWithOutput;
}

function selectImplementationSummaryNodeId(
  graph: DotGraph,
  state: EngineState,
  patchNodeId: string | null
): string | null {
  const preferred = [
    graph.graphAttrs.implementation_summary_node,
    graph.graphAttrs.implementationSummaryNode,
    graph.graphAttrs.final_output_node,
    graph.graphAttrs.finalOutputNode,
    graph.graphAttrs.synthesis_node,
    graph.graphAttrs.synthesisNode,
    patchNodeId ?? undefined
  ];
  const selected = firstOutputNodeId(graph, state, preferred);
  if (selected) {
    return selected;
  }
  return selectFinalOutputNodeId(graph, state);
}

type ImplementationRunRecord = {
  id: string;
  projectId: string;
  sourceBranch: string;
  targetBranch: string;
  githubIssueId: string | null;
  githubPullRequestId: string | null;
  project: {
    repoFullName: string | null;
    defaultBranch: string | null;
    githubInstallationId: string | null;
  };
  githubIssue: {
    issueNumber: number;
    title: string;
    url: string;
    body: string | null;
  } | null;
};

type SupplementalArtifact = {
  key: string;
  content: string;
  nodeId?: string | null;
};

async function applyImplementationResult(args: {
  run: ImplementationRunRecord;
  workDir: string;
  implementationText: string;
  supplementalArtifacts?: SupplementalArtifact[];
}): Promise<{ prUrl: string | null; prNumber: number | null; githubPullRequestId: string | null }> {
  const run = args.run;
  const implementationText = args.implementationText;
  const supplementalArtifacts = args.supplementalArtifacts ?? [];

  await runCommand("git", ["checkout", "-B", run.targetBranch], args.workDir);

  const outputDir = join(args.workDir, ".attractor");
  mkdirSync(outputDir, { recursive: true });
  const outputFile = join(outputDir, `implementation-${run.id}.md`);
  writeFileSync(outputFile, implementationText, "utf8");

  await runCommand("git", ["add", outputFile], args.workDir);

  const extractedDiff = extractUnifiedDiff(implementationText);
  if (extractedDiff) {
    await appendRunEvent(run.id, "ImplementationPatchExtracted", {
      runId: run.id,
      bytes: Buffer.byteLength(extractedDiff, "utf8")
    });
    const patchFile = join(outputDir, `implementation-${run.id}.patch`);
    writeFileSync(patchFile, extractedDiff, "utf8");

    try {
      await runCommand("git", ["apply", "--index", patchFile], args.workDir);
    } catch (error) {
      await appendRunEvent(run.id, "ImplementationPatchApplyFailed", {
        runId: run.id,
        message: error instanceof Error ? error.message : String(error)
      });
      try {
        await runCommand("git", ["apply", "--index", "--recount", "--unidiff-zero", patchFile], args.workDir);
        await appendRunEvent(run.id, "ImplementationPatchApplyRetried", {
          runId: run.id,
          mode: "recount-unidiff-zero"
        });
      } catch (retryError) {
        await appendRunEvent(run.id, "ImplementationPatchApplyRetryFailed", {
          runId: run.id,
          message: retryError instanceof Error ? retryError.message : String(retryError)
        });
        throw retryError;
      }
    }

    const patchArtifactPath = `runs/${run.projectId}/${run.id}/implementation.patch`;
    await putObject(patchArtifactPath, extractedDiff, "text/x-diff");
    await prisma.artifact.create({
      data: {
        runId: run.id,
        key: "implementation.patch",
        path: patchArtifactPath,
        contentType: "text/x-diff",
        sizeBytes: Buffer.byteLength(extractedDiff, "utf8")
      }
    });

    await appendRunEvent(run.id, "ImplementationPatchApplied", {
      runId: run.id,
      patchArtifactPath
    });
  } else {
    await appendRunEvent(run.id, "ImplementationPatchMissing", {
      runId: run.id
    });
  }

  for (const artifact of supplementalArtifacts) {
    const path = `runs/${run.projectId}/${run.id}/${artifact.key}`;
    await putObject(path, artifact.content, "text/markdown");
    await prisma.artifact.create({
      data: {
        runId: run.id,
        key: artifact.key,
        path,
        contentType: "text/markdown",
        sizeBytes: Buffer.byteLength(artifact.content, "utf8")
      }
    });
    await appendRunEvent(run.id, "ImplementationNodeArtifactWritten", {
      runId: run.id,
      nodeId: artifact.nodeId ?? null,
      artifactKey: artifact.key,
      artifactPath: path
    });
  }

  if (!(await hasStagedChanges(args.workDir))) {
    throw new Error("Implementation run produced no staged changes");
  }

  await runCommand("git", ["commit", "-m", `attractor: implementation run ${run.id}`], args.workDir);
  await runCommand("git", ["push", "origin", run.targetBranch, "--force-with-lease"], args.workDir);
  const pushedHeadSha = (await runCommand("git", ["rev-parse", "HEAD"], args.workDir)).trim();

  const artifactPath = `runs/${run.projectId}/${run.id}/implementation-note.md`;
  await putObject(artifactPath, implementationText, "text/markdown");
  await prisma.artifact.create({
    data: {
      runId: run.id,
      key: "implementation-note.md",
      path: artifactPath,
      contentType: "text/markdown",
      sizeBytes: Buffer.byteLength(implementationText, "utf8")
    }
  });

  const prTitle = run.githubIssue
    ? `[#${run.githubIssue.issueNumber}] ${run.githubIssue.title}`
    : `Attractor run ${run.id}`;
  const prBody = [
    `Automated implementation run ${run.id}.`,
    run.githubIssue ? `Closes #${run.githubIssue.issueNumber}` : "",
    "",
    "## Implementation Summary",
    implementationText.slice(0, 5000)
  ]
    .filter((item) => item.length > 0)
    .join("\n");

  if (!run.project.repoFullName) {
    throw new Error(`Run ${run.id} has no repository configured`);
  }

  const prResult = await createPullRequest({
    installationId: run.project.githubInstallationId ?? undefined,
    repoFullName: run.project.repoFullName,
    baseBranch: run.project.defaultBranch ?? run.sourceBranch,
    headBranch: run.targetBranch,
    title: prTitle,
    body: prBody
  });
  const prUrl = prResult.url;

  let githubPullRequestId: string | null = run.githubPullRequestId;
  if (prResult.number) {
    const linkedPr = await prisma.gitHubPullRequest.upsert({
      where: {
        projectId_prNumber: {
          projectId: run.projectId,
          prNumber: prResult.number
        }
      },
      update: {
        state: "open",
        title: prTitle,
        body: prBody,
        url: prUrl ?? "",
        headRefName: run.targetBranch,
        headSha: prResult.headSha ?? pushedHeadSha,
        baseRefName: run.project.defaultBranch ?? run.sourceBranch,
        mergedAt: null,
        updatedAt: new Date(),
        syncedAt: new Date(),
        ...(run.githubIssueId ? { linkedIssueId: run.githubIssueId } : {})
      },
      create: {
        projectId: run.projectId,
        prNumber: prResult.number,
        state: "open",
        title: prTitle,
        body: prBody,
        url: prUrl ?? "",
        headRefName: run.targetBranch,
        headSha: prResult.headSha ?? pushedHeadSha,
        baseRefName: run.project.defaultBranch ?? run.sourceBranch,
        mergedAt: null,
        openedAt: new Date(),
        closedAt: null,
        updatedAt: new Date(),
        syncedAt: new Date(),
        ...(run.githubIssueId ? { linkedIssueId: run.githubIssueId } : {})
      }
    });
    githubPullRequestId = linkedPr.id;
  }

  return {
    prUrl,
    prNumber: prResult.number,
    githubPullRequestId
  };
}

async function processTaskRun(args: {
  runId: string;
  projectId: string;
  repoFullName: string;
  sourceBranch: string;
  targetBranch: string;
  githubPullRequest: {
    prNumber: number;
    title: string;
    body: string | null;
    url: string;
    headRefName: string;
    headSha: string;
    baseRefName: string;
  } | null;
  workDir: string;
  attractorContent: string;
  modelConfig: RunModelConfig;
  checkpoint: { currentNodeId: string; contextJson: unknown } | null;
}): Promise<{
  artifactKey: string;
  artifactPath: string;
  exitNodeId: string;
  finalNodeId: string | null;
}> {
  const parsed = parseDotGraph(args.attractorContent);
  const stylesheetConfig = parsed.graphAttrs.model_stylesheet ?? parsed.graphAttrs.modelStylesheet;
  if (stylesheetConfig && stylesheetConfig.trim().length > 0) {
    const trimmed = stylesheetConfig.trim();
    const source = trimmed.includes("{")
      ? trimmed
      : readFileSync(join(args.workDir, trimmed), "utf8");
    const rules = parseModelStylesheet(source);
    parsed.graphAttrs.model_stylesheet = source;
    await appendRunEvent(args.runId, "ModelStylesheetLoaded", {
      runId: args.runId,
      ruleCount: rules.length
    });
  }
  const graph = applyGraphTransforms(parsed);
  validateDotGraph(graph);

  const snapshot = buildRepositorySnapshot(args.workDir);
  await appendRunEvent(args.runId, "TaskRepositorySnapshotPrepared", {
    runId: args.runId,
    filesIncluded: snapshot.filesIncluded,
    truncated: snapshot.truncated
  });

  const restoredState = normalizeEngineState(args.checkpoint?.contextJson);
  const initialState: EngineState =
    restoredState ?? {
      context: {},
      nodeOutputs: {},
      parallelOutputs: {},
      nodeOutcomes: {},
      nodeRetryCounts: {},
      completedNodes: []
    };

  initialState.context = {
    ...initialState.context,
    runId: args.runId,
    repository: args.repoFullName,
    sourceBranch: args.sourceBranch,
    targetBranch: args.targetBranch,
    githubPullRequest: args.githubPullRequest,
    repositoryTree: snapshot.tree,
    repositorySnapshot: snapshot.content
  };

  const modelResolutions = new Map<
    string,
    {
      nodeId: string;
      requested: RunModelConfig;
      resolved: RunModelConfig;
      fallback?: { fromModelId: string; toModelId: string; reason: string };
    }
  >();

  const maxSteps = parseOptionalInt(graph.graphAttrs.max_steps ?? graph.graphAttrs.maxSteps) ?? 1000;
  const execution = await executeGraph({
    graph,
    initialState,
    ...(args.checkpoint?.currentNodeId ? { startNodeId: args.checkpoint.currentNodeId } : {}),
    maxSteps,
    callbacks: {
      codergen: async ({ node, prompt, state }) => {
        await assertRunNotCanceled(args.runId);
        const requested = nodeModelConfig(args.modelConfig, node);
        const result = await runCodergen(prompt, args.runId, requested, `Node.${node.id}.`);
        modelResolutions.set(node.id, {
          nodeId: node.id,
          requested,
          resolved: result.modelConfig,
          ...(result.fallback ? { fallback: result.fallback } : {})
        });
        if (result.fallback) {
          await appendRunEvent(args.runId, "ModelFallbackApplied", {
            runId: args.runId,
            nodeId: node.id,
            provider: result.modelConfig.provider,
            fromModelId: result.fallback.fromModelId,
            toModelId: result.fallback.toModelId,
            reason: result.fallback.reason
          });
        }
        return result.text;
      },
      tool: async ({ node }) => {
        const outcome = await executeToolNode({
          node,
          workDir: args.workDir,
          runCommand,
          defaultOutput: `Tool node ${node.id} executed`
        });

        if (outcome.kind === "command_failure") {
          await appendRunEvent(args.runId, "TaskToolNodeCommandFailed", {
            runId: args.runId,
            nodeId: node.id,
            tool: outcome.tool,
            command: outcome.command,
            cwd: outcome.cwd,
            timeoutMs: outcome.timeoutMs,
            outputPreview: outcome.outputPreview
          });
          return outcome.output;
        }

        await appendRunEvent(args.runId, "TaskToolNodeExecuted", {
          runId: args.runId,
          nodeId: node.id,
          tool: outcome.tool,
          ...(outcome.kind === "command_success"
            ? {
                command: outcome.command,
                cwd: outcome.cwd,
                timeoutMs: outcome.timeoutMs,
                outputPreview: outcome.outputPreview
              }
            : {})
        });
        return outcome.output;
      },
      waitForHuman: async (question) =>
        waitForHumanQuestion({
          runId: args.runId,
          nodeId: question.nodeId,
          prompt: question.prompt,
          options: question.options,
          timeoutMs: question.timeoutMs
        }),
      onEvent: async (event) => {
        await appendRunEvent(args.runId, `Engine${event.type}`, {
          runId: args.runId,
          ...(event.nodeId ? { nodeId: event.nodeId } : {}),
          ...(event.payload !== undefined ? { payload: event.payload } : {})
        });
      },
      saveCheckpoint: async (nodeId, state) => {
        await prisma.runCheckpoint.upsert({
          where: { runId: args.runId },
          update: {
            currentNodeId: nodeId,
            contextJson: state as never
          },
          create: {
            runId: args.runId,
            currentNodeId: nodeId,
            contextJson: state as never
          }
        });
      },
      saveOutcome: async (nodeId, status, payload, attempt) => {
        await prisma.runNodeOutcome.create({
          data: {
            runId: args.runId,
            nodeId,
            status,
            attempt,
            payload: payload as never
          }
        });
      }
    }
  });

  const finalNodeId = selectFinalOutputNodeId(graph, execution.state);
  const outputText = finalNodeId ? execution.state.nodeOutputs[finalNodeId] ?? "" : "";
  const finalArtifactKey = normalizeArtifactKey(
    graph.graphAttrs.final_artifact_key ?? graph.graphAttrs.finalArtifactKey ?? "task-report.md",
    "task-report.md"
  );
  const reviewerArtifactNodes = parseArtifactNodeList(
    graph.graphAttrs.reviewer_artifact_nodes ??
      graph.graphAttrs.reviewerArtifactNodes ??
      graph.graphAttrs.additional_artifact_nodes ??
      graph.graphAttrs.additionalArtifactNodes
  );

  const report = renderTaskReport({
    output: outputText,
    runId: args.runId,
    repoFullName: args.repoFullName,
    sourceBranch: args.sourceBranch,
    exitNodeId: execution.exitNodeId,
    finalNodeId,
    modelResolutions: [...modelResolutions.values()]
  });

  type PendingArtifact = {
    key: string;
    content: string;
    nodeId: string | null;
  };

  const pendingArtifacts: PendingArtifact[] = [];
  for (const nodeId of reviewerArtifactNodes) {
    const nodeOutput = resolveTaskNodeOutput(graph, execution.state, nodeId);
    const outputBody =
      nodeOutput && nodeOutput.trim().length > 0
        ? nodeOutput.trim()
        : [
            "# Reviewer Output Unavailable",
            "",
            `Node: \`${nodeId}\``,
            `Status: \`${execution.state.nodeOutcomes[nodeId]?.status ?? "UNKNOWN"}\``,
            "",
            execution.state.nodeOutcomes[nodeId]?.failureReason ?? "The reviewer node did not produce markdown output."
          ].join("\n");
    pendingArtifacts.push({
      key: reviewerArtifactKey(nodeId),
      content: `${outputBody}\n`,
      nodeId
    });
  }

  pendingArtifacts.push({
    key: finalArtifactKey,
    content: report,
    nodeId: finalNodeId
  });

  const usedKeys = new Set<string>();
  const artifactsToWrite = pendingArtifacts.map((artifact) => {
    const normalizedKey = normalizeArtifactKey(artifact.key, "task-report.md");
    const key = withUniqueArtifactKey(normalizedKey, usedKeys);
    return {
      ...artifact,
      key,
      path: `runs/${args.projectId}/${args.runId}/${key}`
    };
  });

  const finalArtifact = artifactsToWrite[artifactsToWrite.length - 1];
  if (!finalArtifact) {
    throw new Error("Task run produced no artifacts to write");
  }

  await prisma.artifact.deleteMany({
    where: {
      runId: args.runId
    }
  });

  for (const artifact of artifactsToWrite) {
    await putObject(artifact.path, artifact.content, "text/markdown");
    await prisma.artifact.create({
      data: {
        runId: args.runId,
        key: artifact.key,
        path: artifact.path,
        contentType: "text/markdown",
        sizeBytes: Buffer.byteLength(artifact.content, "utf8")
      }
    });

    if (artifact !== finalArtifact) {
      await appendRunEvent(args.runId, "TaskNodeArtifactWritten", {
        runId: args.runId,
        nodeId: artifact.nodeId,
        artifactKey: artifact.key,
        artifactPath: artifact.path
      });
    }
  }

  await appendRunEvent(args.runId, "TaskArtifactWritten", {
    runId: args.runId,
    artifactKey: finalArtifact.key,
    artifactPath: finalArtifact.path,
    finalNodeId,
    exitNodeId: execution.exitNodeId
  });

  return {
    artifactKey: finalArtifact.key,
    artifactPath: finalArtifact.path,
    exitNodeId: execution.exitNodeId,
    finalNodeId
  };
}

async function processImplementationDotRun(args: {
  run: ImplementationRunRecord;
  workDir: string;
  attractorContent: string;
  modelConfig: RunModelConfig;
  checkpoint: { currentNodeId: string; contextJson: unknown } | null;
}): Promise<{
  prUrl: string | null;
  prNumber: number | null;
  githubPullRequestId: string | null;
  exitNodeId: string;
  finalNodeId: string | null;
  patchNodeId: string | null;
  summaryNodeId: string | null;
}> {
  const parsed = parseDotGraph(args.attractorContent);
  if (!isDotImplementationGraph(parsed)) {
    throw new Error("Attractor does not enable DOT implementation mode");
  }

  const stylesheetConfig = parsed.graphAttrs.model_stylesheet ?? parsed.graphAttrs.modelStylesheet;
  if (stylesheetConfig && stylesheetConfig.trim().length > 0) {
    const trimmed = stylesheetConfig.trim();
    const source = trimmed.includes("{")
      ? trimmed
      : readFileSync(join(args.workDir, trimmed), "utf8");
    const rules = parseModelStylesheet(source);
    parsed.graphAttrs.model_stylesheet = source;
    await appendRunEvent(args.run.id, "ModelStylesheetLoaded", {
      runId: args.run.id,
      ruleCount: rules.length
    });
  }

  const graph = applyGraphTransforms(parsed);
  validateDotGraph(graph);

  const snapshot = buildRepositorySnapshot(args.workDir);
  await appendRunEvent(args.run.id, "ImplementationRepositorySnapshotPrepared", {
    runId: args.run.id,
    filesIncluded: snapshot.filesIncluded,
    truncated: snapshot.truncated
  });

  const restoredState = normalizeEngineState(args.checkpoint?.contextJson);
  const initialState: EngineState =
    restoredState ?? {
      context: {},
      nodeOutputs: {},
      parallelOutputs: {},
      nodeOutcomes: {},
      nodeRetryCounts: {},
      completedNodes: []
    };

  initialState.context = {
    ...initialState.context,
    runId: args.run.id,
    repository: args.run.project.repoFullName,
    sourceBranch: args.run.sourceBranch,
    targetBranch: args.run.targetBranch,
    repositoryTree: snapshot.tree,
    repositorySnapshot: snapshot.content
  };

  const modelResolutions = new Map<
    string,
    {
      nodeId: string;
      requested: RunModelConfig;
      resolved: RunModelConfig;
      fallback?: { fromModelId: string; toModelId: string; reason: string };
    }
  >();

  const maxSteps = parseOptionalInt(graph.graphAttrs.max_steps ?? graph.graphAttrs.maxSteps) ?? 1000;
  const execution = await executeGraph({
    graph,
    initialState,
    ...(args.checkpoint?.currentNodeId ? { startNodeId: args.checkpoint.currentNodeId } : {}),
    maxSteps,
    callbacks: {
      codergen: async ({ node, prompt }) => {
        await assertRunNotCanceled(args.run.id);
        const requested = nodeModelConfig(args.modelConfig, node);
        const result = await runCodergen(prompt, args.run.id, requested, `Node.${node.id}.`);
        modelResolutions.set(node.id, {
          nodeId: node.id,
          requested,
          resolved: result.modelConfig,
          ...(result.fallback ? { fallback: result.fallback } : {})
        });
        if (result.fallback) {
          await appendRunEvent(args.run.id, "ModelFallbackApplied", {
            runId: args.run.id,
            nodeId: node.id,
            provider: result.modelConfig.provider,
            fromModelId: result.fallback.fromModelId,
            toModelId: result.fallback.toModelId,
            reason: result.fallback.reason
          });
        }
        return result.text;
      },
      tool: async ({ node }) => {
        const outcome = await executeToolNode({
          node,
          workDir: args.workDir,
          runCommand,
          defaultOutput: `Tool node ${node.id} executed`
        });

        if (outcome.kind === "command_failure") {
          await appendRunEvent(args.run.id, "ImplementationToolNodeCommandFailed", {
            runId: args.run.id,
            nodeId: node.id,
            tool: outcome.tool,
            command: outcome.command,
            cwd: outcome.cwd,
            timeoutMs: outcome.timeoutMs,
            outputPreview: outcome.outputPreview
          });
          return outcome.output;
        }

        await appendRunEvent(args.run.id, "ImplementationToolNodeExecuted", {
          runId: args.run.id,
          nodeId: node.id,
          tool: outcome.tool,
          ...(outcome.kind === "command_success"
            ? {
                command: outcome.command,
                cwd: outcome.cwd,
                timeoutMs: outcome.timeoutMs,
                outputPreview: outcome.outputPreview
              }
            : {})
        });
        return outcome.output;
      },
      waitForHuman: async (question) =>
        waitForHumanQuestion({
          runId: args.run.id,
          nodeId: question.nodeId,
          prompt: question.prompt,
          options: question.options,
          timeoutMs: question.timeoutMs
        }),
      onEvent: async (event) => {
        await appendRunEvent(args.run.id, `Engine${event.type}`, {
          runId: args.run.id,
          ...(event.nodeId ? { nodeId: event.nodeId } : {}),
          ...(event.payload !== undefined ? { payload: event.payload } : {})
        });
      },
      saveCheckpoint: async (nodeId, state) => {
        await prisma.runCheckpoint.upsert({
          where: { runId: args.run.id },
          update: {
            currentNodeId: nodeId,
            contextJson: state as never
          },
          create: {
            runId: args.run.id,
            currentNodeId: nodeId,
            contextJson: state as never
          }
        });
      },
      saveOutcome: async (nodeId, status, payload, attempt) => {
        await prisma.runNodeOutcome.create({
          data: {
            runId: args.run.id,
            nodeId,
            status,
            attempt,
            payload: payload as never
          }
        });
      }
    }
  });

  const finalNodeId = selectFinalOutputNodeId(graph, execution.state);
  const patchNodeId = selectImplementationPatchNodeId(graph, execution.state);
  const summaryNodeId = selectImplementationSummaryNodeId(graph, execution.state, patchNodeId);

  const patchOutput = patchNodeId ? resolveTaskNodeOutput(graph, execution.state, patchNodeId) : "";
  const summaryOutput = summaryNodeId ? resolveTaskNodeOutput(graph, execution.state, summaryNodeId) : "";

  let implementationText = summaryOutput.trim().length > 0 ? summaryOutput.trim() : patchOutput.trim();
  if (implementationText.length === 0 && finalNodeId) {
    implementationText = resolveTaskNodeOutput(graph, execution.state, finalNodeId).trim();
  }
  if (patchOutput.trim().length > 0 && !extractUnifiedDiff(implementationText)) {
    implementationText = [implementationText, patchOutput.trim()].filter(Boolean).join("\n\n");
  }
  implementationText = implementationText.length > 0 ? `${implementationText}\n` : "";
  if (!implementationText) {
    throw new Error("DOT implementation run produced no implementation output");
  }

  const reviewerArtifactNodes = parseArtifactNodeList(
    graph.graphAttrs.reviewer_artifact_nodes ??
      graph.graphAttrs.reviewerArtifactNodes ??
      graph.graphAttrs.additional_artifact_nodes ??
      graph.graphAttrs.additionalArtifactNodes
  );
  const reviewerArtifacts: SupplementalArtifact[] = [];
  const usedKeys = new Set<string>(["implementation.patch", "implementation-note.md"]);
  for (const nodeId of reviewerArtifactNodes) {
    const nodeOutput = resolveTaskNodeOutput(graph, execution.state, nodeId);
    const body =
      nodeOutput && nodeOutput.trim().length > 0
        ? nodeOutput.trim()
        : [
            "# Reviewer Output Unavailable",
            "",
            `Node: \`${nodeId}\``,
            `Status: \`${execution.state.nodeOutcomes[nodeId]?.status ?? "UNKNOWN"}\``,
            "",
            execution.state.nodeOutcomes[nodeId]?.failureReason ??
              "The reviewer node did not produce markdown output."
          ].join("\n");
    const desiredKey = reviewerArtifactKey(nodeId);
    const key = withUniqueArtifactKey(normalizeArtifactKey(desiredKey, desiredKey), usedKeys);
    reviewerArtifacts.push({
      key,
      content: `${body}\n`,
      nodeId
    });
  }

  const applyResult = await applyImplementationResult({
    run: args.run,
    workDir: args.workDir,
    implementationText,
    supplementalArtifacts: reviewerArtifacts
  });

  await appendRunEvent(args.run.id, "ImplementationDotCompleted", {
    runId: args.run.id,
    exitNodeId: execution.exitNodeId,
    finalNodeId,
    patchNodeId,
    summaryNodeId,
    modelResolutions: [...modelResolutions.values()]
  });

  return {
    prUrl: applyResult.prUrl,
    prNumber: applyResult.prNumber,
    githubPullRequestId: applyResult.githubPullRequestId,
    exitNodeId: execution.exitNodeId,
    finalNodeId,
    patchNodeId,
    summaryNodeId
  };
}

async function processRun(spec: RunExecutionSpec): Promise<void> {
  const environment = parseEnvironmentSpec(spec);
  const run = await prisma.run.findUnique({
    where: { id: spec.runId },
    include: {
      project: true,
      attractorDef: true,
      referencedSpecBundle: true,
      checkpoint: true,
      githubIssue: true,
      githubPullRequest: true
    }
  });

  if (!run) {
    throw new Error(`Run ${spec.runId} not found`);
  }

  await prisma.run.update({
    where: { id: run.id },
    data: {
      status: RunStatus.RUNNING,
      startedAt: run.startedAt ?? new Date()
    }
  });

  await appendRunEvent(run.id, "RunStarted", {
    runId: run.id,
    runType: run.runType,
    sourceBranch: run.sourceBranch,
    targetBranch: run.targetBranch
  });

  await appendRunEvent(run.id, "EnvironmentResolved", {
    runId: run.id,
    environment
  });

  if (!run.project.repoFullName) {
    throw new Error("Project repository is not connected");
  }

  await assertRunNotCanceled(run.id);
  const workDir = await checkoutRepository(
    run.id,
    run.project.repoFullName,
    run.sourceBranch,
    run.project.githubInstallationId ?? undefined
  );

  try {
    await runEnvironmentSetupScript({
      runId: run.id,
      workDir,
      environment
    });

    const attractorResolved = await loadAttractorContent({
      workDir,
      snapshot: {
        contentPath: run.attractorContentPath,
        contentVersion: run.attractorContentVersion,
        contentSha256: run.attractorContentSha256
      },
      attractor: {
        name: run.attractorDef.name,
        repoPath: run.attractorDef.repoPath,
        contentPath: run.attractorDef.contentPath,
        contentVersion: run.attractorDef.contentVersion
      }
    });
    const attractorContent = attractorResolved.content;

    await appendRunEvent(run.id, "AttractorContentResolved", {
      runId: run.id,
      attractorDefId: run.attractorDefId,
      source: attractorResolved.source,
      path: attractorResolved.path,
      contentVersion: run.attractorContentVersion ?? run.attractorDef.contentVersion
    });

    if (run.runType === RunType.task) {
      const taskResult = await processTaskRun({
        runId: run.id,
        projectId: run.projectId,
        repoFullName: run.project.repoFullName,
        sourceBranch: run.sourceBranch,
        targetBranch: run.targetBranch,
        githubPullRequest: run.githubPullRequest
          ? {
              prNumber: run.githubPullRequest.prNumber,
              title: run.githubPullRequest.title,
              body: run.githubPullRequest.body,
              url: run.githubPullRequest.url,
              headRefName: run.githubPullRequest.headRefName,
              headSha: run.githubPullRequest.headSha,
              baseRefName: run.githubPullRequest.baseRefName
            }
          : null,
        workDir,
        attractorContent,
        modelConfig: spec.modelConfig,
        checkpoint: run.checkpoint
          ? {
              currentNodeId: run.checkpoint.currentNodeId,
              contextJson: run.checkpoint.contextJson
            }
          : null
      });

      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: RunStatus.SUCCEEDED,
          finishedAt: new Date(),
          prUrl: null
        }
      });

      await appendRunEvent(run.id, "RunCompleted", {
        runId: run.id,
        status: "SUCCEEDED",
        artifactKey: taskResult.artifactKey,
        artifactPath: taskResult.artifactPath,
        exitNodeId: taskResult.exitNodeId,
        finalNodeId: taskResult.finalNodeId
      });
      return;
    }

    if (run.runType === RunType.planning) {
      const planPrompt = [
        "You are generating a project planning bundle for a coding run.",
        `Repository: ${run.project.repoFullName}`,
        `Source branch: ${run.sourceBranch}`,
        "Produce an actionable plan and requirements with acceptance tests.",
        "Attractor definition:",
        attractorContent
      ].join("\n\n");

      const planResult = await runCodergen(planPrompt, run.id, spec.modelConfig);
      if (planResult.fallback) {
        await appendRunEvent(run.id, "ModelFallbackApplied", {
          runId: run.id,
          provider: planResult.modelConfig.provider,
          fromModelId: planResult.fallback.fromModelId,
          toModelId: planResult.fallback.toModelId,
          reason: planResult.fallback.reason
        });
      }

      const bundle = await createSpecBundle(
        run.id,
        run.projectId,
        run.sourceBranch,
        run.project.repoFullName,
        planResult.text
      );

      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: RunStatus.SUCCEEDED,
          finishedAt: new Date(),
          specBundleId: bundle.specBundleId
        }
      });

      await appendRunEvent(run.id, "RunCompleted", {
        runId: run.id,
        status: "SUCCEEDED",
        manifestPath: bundle.manifestPath
      });
      return;
    }

    if (!run.specBundleId || !run.referencedSpecBundle) {
      if (isDotImplementationAttractor(attractorContent)) {
        const implementationDotResult = await processImplementationDotRun({
          run: {
            id: run.id,
            projectId: run.projectId,
            sourceBranch: run.sourceBranch,
            targetBranch: run.targetBranch,
            githubIssueId: run.githubIssueId,
            githubPullRequestId: run.githubPullRequestId,
            project: {
              repoFullName: run.project.repoFullName,
              defaultBranch: run.project.defaultBranch,
              githubInstallationId: run.project.githubInstallationId
            },
            githubIssue: run.githubIssue
              ? {
                  issueNumber: run.githubIssue.issueNumber,
                  title: run.githubIssue.title,
                  url: run.githubIssue.url,
                  body: run.githubIssue.body
                }
              : null
          },
          workDir,
          attractorContent,
          modelConfig: spec.modelConfig,
          checkpoint: run.checkpoint
            ? {
                currentNodeId: run.checkpoint.currentNodeId,
                contextJson: run.checkpoint.contextJson
              }
            : null
        });

        await prisma.run.update({
          where: { id: run.id },
          data: {
            status: RunStatus.SUCCEEDED,
            finishedAt: new Date(),
            prUrl: implementationDotResult.prUrl,
            githubPullRequestId: implementationDotResult.githubPullRequestId
          }
        });

        await appendRunEvent(run.id, "RunCompleted", {
          runId: run.id,
          status: "SUCCEEDED",
          prUrl: implementationDotResult.prUrl,
          prNumber: implementationDotResult.prNumber,
          dotExecution: {
            exitNodeId: implementationDotResult.exitNodeId,
            finalNodeId: implementationDotResult.finalNodeId,
            patchNodeId: implementationDotResult.patchNodeId,
            summaryNodeId: implementationDotResult.summaryNodeId
          }
        });
        return;
      }

      throw new Error(
        "Implementation run requires specBundleId unless attractor enables DOT implementation mode"
      );
    }

    if (run.referencedSpecBundle.schemaVersion !== "v1") {
      throw new Error(`Unsupported spec bundle schema version ${run.referencedSpecBundle.schemaVersion}`);
    }

    const manifestRaw = await getObjectString(run.referencedSpecBundle.manifestPath);
    const manifest = JSON.parse(manifestRaw) as { artifacts?: Array<{ path: string }> };

    const planPath = manifest.artifacts?.find((artifact) => artifact.path.endsWith("plan.md"))?.path;
    const planText = planPath ? await getObjectString(planPath) : "No plan.md found in bundle";
    const issueContext = run.githubIssue
      ? [
          `Linked GitHub issue: #${run.githubIssue.issueNumber}`,
          `Issue title: ${run.githubIssue.title}`,
          `Issue URL: ${run.githubIssue.url}`,
          "Issue body:",
          run.githubIssue.body ?? "(empty)"
        ].join("\n")
      : "No linked GitHub issue.";

    const implementPrompt = [
      "You are implementing a planned change in a repository.",
      `Repository: ${run.project.repoFullName}`,
      `Source branch: ${run.sourceBranch}`,
      `Target branch: ${run.targetBranch}`,
      issueContext,
      "Use the plan to produce concrete code changes.",
      "Return a concise summary and a valid unified git diff in a fenced ```diff block.",
      "The diff must be directly applicable from repository root with git apply.",
      "Plan:",
      planText
    ].join("\n\n");

    const implementationResult = await runCodergen(
      implementPrompt,
      run.id,
      spec.modelConfig
    );
    if (implementationResult.fallback) {
      await appendRunEvent(run.id, "ModelFallbackApplied", {
        runId: run.id,
        provider: implementationResult.modelConfig.provider,
        fromModelId: implementationResult.fallback.fromModelId,
        toModelId: implementationResult.fallback.toModelId,
        reason: implementationResult.fallback.reason
      });
    }
    const implementationText = implementationResult.text;

    const implementationApplyResult = await applyImplementationResult({
      run: {
        id: run.id,
        projectId: run.projectId,
        sourceBranch: run.sourceBranch,
        targetBranch: run.targetBranch,
        githubIssueId: run.githubIssueId,
        githubPullRequestId: run.githubPullRequestId,
        project: {
          repoFullName: run.project.repoFullName,
          defaultBranch: run.project.defaultBranch,
          githubInstallationId: run.project.githubInstallationId
        },
        githubIssue: run.githubIssue
          ? {
              issueNumber: run.githubIssue.issueNumber,
              title: run.githubIssue.title,
              url: run.githubIssue.url,
              body: run.githubIssue.body
            }
          : null
      },
      workDir,
      implementationText
    });

    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: RunStatus.SUCCEEDED,
        finishedAt: new Date(),
        prUrl: implementationApplyResult.prUrl,
        githubPullRequestId: implementationApplyResult.githubPullRequestId
      }
    });

    await appendRunEvent(run.id, "RunCompleted", {
      runId: run.id,
      status: "SUCCEEDED",
      prUrl: implementationApplyResult.prUrl,
      prNumber: implementationApplyResult.prNumber
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    if (run.runType === RunType.implementation) {
      await redis.del(runLockKey(run.projectId, run.targetBranch));
    }
  }
}

async function main() {
  const spec = parseSpec();
  await ensureBucketExists();

  try {
    await processRun(spec);
  } catch (error) {
    const runId = spec.runId;
    await prisma.run.update({
      where: { id: runId },
      data: {
        status: RunStatus.FAILED,
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error)
      }
    });

    await appendRunEvent(runId, "RunFailed", {
      runId,
      message: error instanceof Error ? error.message : String(error)
    });

    if (spec.runType === "implementation") {
      await redis.del(runLockKey(spec.projectId, spec.targetBranch));
    }

    throw error;
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error}\n`);
  process.exitCode = 1;
});
