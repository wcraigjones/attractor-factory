import { BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { PrismaClient, RunStatus, RunType } from "@prisma/client";
import { Redis } from "ioredis";
import {
  runCancelKey,
  runEventChannel,
  runLockKey,
  runQueueKey,
  type RunExecutionEnvironment,
  type RunExecutionSpec,
  type RunModelConfig
} from "@attractor/shared-types";
import {
  buildRunnerJobManifest,
  getProviderSecretSchema,
  materializeProviderSecretEnv,
  type ProjectProviderSecretMapping
} from "@attractor/shared-k8s";

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");

const POLL_TIMEOUT_SECONDS = Number(process.env.RUN_QUEUE_POLL_TIMEOUT_SECONDS ?? 5);
const PROJECT_CONCURRENCY_LIMIT = Number(process.env.PROJECT_CONCURRENCY_LIMIT ?? 5);
const RUNNER_FALLBACK_IMAGE =
  process.env.RUNNER_IMAGE ?? "ghcr.io/wcraigjones/attractor-factory-runner:latest";
const FACTORY_API_BASE_URL = process.env.FACTORY_API_BASE_URL ?? "http://factory-api.factory-system.svc.cluster.local:8080";
const POSTGRES_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@postgres.factory-system.svc.cluster.local:5432/factory";
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://minio.factory-system.svc.cluster.local:9000";
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "factory-artifacts";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "minioadmin";
const SERVICE_ACCOUNT = process.env.RUNNER_SERVICE_ACCOUNT ?? "factory-runner";

const kc = new KubeConfig();
kc.loadFromDefault();
const coreApi = kc.makeApiClient(CoreV1Api);
const batchApi = kc.makeApiClient(BatchV1Api);

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

async function ensureServiceAccount(namespace: string, serviceAccountName: string): Promise<void> {
  try {
    await coreApi.readNamespacedServiceAccount({ namespace, name: serviceAccountName });
    return;
  } catch {
    await coreApi.createNamespacedServiceAccount({
      namespace,
      body: {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: {
          namespace,
          name: serviceAccountName
        }
      }
    });
  }
}

async function modelConfigForRun(runId: string): Promise<RunModelConfig> {
  const queuedEvent = await prisma.runEvent.findFirst({
    where: {
      runId,
      type: "RunQueued"
    },
    orderBy: {
      ts: "asc"
    }
  });

  if (!queuedEvent || typeof queuedEvent.payload !== "object" || !queuedEvent.payload) {
    throw new Error(`RunQueued event missing modelConfig for run ${runId}`);
  }

  const payload = queuedEvent.payload as { modelConfig?: RunModelConfig };
  if (!payload.modelConfig?.provider || !payload.modelConfig?.modelId) {
    throw new Error(`RunQueued modelConfig invalid for run ${runId}`);
  }

  return payload.modelConfig;
}

function normalizeSnapshot(value: unknown): RunExecutionEnvironment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const snapshot = value as {
    id?: unknown;
    name?: unknown;
    kind?: unknown;
    runnerImage?: unknown;
    setupScript?: unknown;
    serviceAccountName?: unknown;
    resources?: unknown;
  };

  if (
    typeof snapshot.id !== "string" ||
    typeof snapshot.name !== "string" ||
    snapshot.kind !== "KUBERNETES_JOB" ||
    typeof snapshot.runnerImage !== "string"
  ) {
    return null;
  }

  return {
    id: snapshot.id,
    name: snapshot.name,
    kind: "KUBERNETES_JOB",
    runnerImage: snapshot.runnerImage,
    ...(typeof snapshot.setupScript === "string" ? { setupScript: snapshot.setupScript } : {}),
    ...(typeof snapshot.serviceAccountName === "string"
      ? { serviceAccountName: snapshot.serviceAccountName }
      : {}),
    ...(snapshot.resources && typeof snapshot.resources === "object"
      ? { resources: snapshot.resources as RunExecutionEnvironment["resources"] }
      : {})
  };
}

async function enqueueRun(runId: string): Promise<void> {
  await redis.rpush(runQueueKey(), runId);
}

async function processRun(runId: string): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      project: true,
      attractorDef: true,
      referencedSpecBundle: true,
      environment: true
    }
  });

  if (!run) {
    return;
  }

  if (run.status !== RunStatus.QUEUED) {
    return;
  }

  const canceled = await redis.get(runCancelKey(run.id));
  if (canceled) {
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: RunStatus.CANCELED,
        finishedAt: new Date()
      }
    });
    await appendRunEvent(run.id, "RunCanceledBeforeDispatch", { runId: run.id });
    return;
  }

  const activeRuns = await prisma.run.count({
    where: {
      projectId: run.projectId,
      status: RunStatus.RUNNING
    }
  });

  if (activeRuns >= PROJECT_CONCURRENCY_LIMIT) {
    await appendRunEvent(run.id, "RunDeferredConcurrency", {
      projectId: run.projectId,
      activeRuns,
      limit: PROJECT_CONCURRENCY_LIMIT
    });
    await enqueueRun(run.id);
    return;
  }

  let branchLockAcquired = false;
  if (run.runType === RunType.implementation) {
    const lockKey = runLockKey(run.projectId, run.targetBranch);
    const lockResult = await redis.set(lockKey, run.id, "EX", 7200, "NX");
    branchLockAcquired = lockResult === "OK";
    if (!branchLockAcquired) {
      await appendRunEvent(run.id, "RunDeferredBranchLock", {
        projectId: run.projectId,
        targetBranch: run.targetBranch
      });
      await enqueueRun(run.id);
      return;
    }
  }

  try {
    const snapshot = normalizeSnapshot(run.environmentSnapshot);
    const resolvedEnvironment: RunExecutionEnvironment = snapshot ?? {
      id: run.environment?.id ?? "legacy-default",
      name: run.environment?.name ?? "legacy-default",
      kind: "KUBERNETES_JOB",
      runnerImage: run.environment?.runnerImage ?? RUNNER_FALLBACK_IMAGE,
      ...(run.environment?.setupScript ? { setupScript: run.environment.setupScript } : {}),
      ...(run.environment?.serviceAccountName
        ? { serviceAccountName: run.environment.serviceAccountName }
        : {}),
      ...(run.environment?.resourcesJson && typeof run.environment.resourcesJson === "object"
        ? { resources: run.environment.resourcesJson as RunExecutionEnvironment["resources"] }
        : {})
    };

    const effectiveServiceAccount = resolvedEnvironment.serviceAccountName ?? SERVICE_ACCOUNT;
    await ensureServiceAccount(run.project.namespace, effectiveServiceAccount);

    const [projectSecrets, globalSecrets] = await Promise.all([
      prisma.projectSecret.findMany({ where: { projectId: run.projectId } }),
      prisma.globalSecret.findMany()
    ]);

    const globalMappings: ProjectProviderSecretMapping[] = globalSecrets.map((secret) => ({
      provider: secret.provider,
      secretName: secret.k8sSecretName,
      keys: secret.keyMappings as Record<string, string>
    }));
    const projectMappings: ProjectProviderSecretMapping[] = projectSecrets.map((secret) => ({
      provider: secret.provider,
      secretName: secret.k8sSecretName,
      keys: secret.keyMappings as Record<string, string>
    }));

    // Project mappings intentionally override global mappings for the same provider.
    const mappingsByProvider = new Map<string, ProjectProviderSecretMapping>();
    for (const mapping of globalMappings) {
      mappingsByProvider.set(mapping.provider, mapping);
    }
    for (const mapping of projectMappings) {
      mappingsByProvider.set(mapping.provider, mapping);
    }
    const mappings = [...mappingsByProvider.values()];
    const providerMappings = mappings.filter((mapping) => getProviderSecretSchema(mapping.provider) !== null);

    const modelConfig = await modelConfigForRun(run.id);
    const providerSecretExists = providerMappings.some((mapping) => mapping.provider === modelConfig.provider);
    if (!providerSecretExists) {
      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: RunStatus.FAILED,
          error: `Missing secret mapping for provider ${modelConfig.provider}`,
          finishedAt: new Date()
        }
      });
      await appendRunEvent(run.id, "RunRejectedMissingProviderSecret", {
        runId: run.id,
        provider: modelConfig.provider
      });
      if (branchLockAcquired && run.runType === RunType.implementation) {
        await redis.del(runLockKey(run.projectId, run.targetBranch));
      }
      return;
    }

    const secretEnv = providerMappings.flatMap((mapping) => materializeProviderSecretEnv(mapping));

    const executionSpec: RunExecutionSpec = {
      runId: run.id,
      projectId: run.projectId,
      runType: run.runType,
      attractorDefId: run.attractorDefId,
      environment: resolvedEnvironment,
      sourceBranch: run.sourceBranch,
      targetBranch: run.targetBranch,
      ...(run.specBundleId ? { specBundleId: run.specBundleId } : {}),
      modelConfig,
      secretsRef: [
        ...globalSecrets.map((secret) => `global:${secret.name}`),
        ...projectSecrets.map((secret) => `project:${secret.name}`)
      ],
      artifactPrefix: `${run.projectId}/${run.id}`
    };

    const job = buildRunnerJobManifest({
      runId: run.id,
      namespace: run.project.namespace,
      image: resolvedEnvironment.runnerImage,
      executionSpec,
      secretEnv,
      apiBaseUrl: FACTORY_API_BASE_URL,
      redisUrl: process.env.REDIS_URL ?? "redis://redis.factory-system.svc.cluster.local:6379",
      postgresUrl: POSTGRES_URL,
      minioEndpoint: MINIO_ENDPOINT,
      minioBucket: MINIO_BUCKET,
      minioAccessKey: MINIO_ACCESS_KEY,
      minioSecretKey: MINIO_SECRET_KEY,
      githubAppId: process.env.GITHUB_APP_ID,
      githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
      githubToken: process.env.GITHUB_TOKEN,
      defaultServiceAccountName: SERVICE_ACCOUNT
    });

    await batchApi.createNamespacedJob({ namespace: run.project.namespace, body: job });

    const updated = await prisma.run.update({
      where: { id: run.id },
      data: {
        status: RunStatus.RUNNING,
        startedAt: new Date()
      }
    });

    await appendRunEvent(run.id, "RunDispatched", {
      runId: run.id,
      status: updated.status,
      namespace: run.project.namespace,
      jobName: job.metadata?.name,
      runType: run.runType,
      environment: resolvedEnvironment
    });
  } catch (error) {
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: RunStatus.FAILED,
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date()
      }
    });

    await appendRunEvent(run.id, "RunDispatchFailed", {
      runId: run.id,
      message: error instanceof Error ? error.message : String(error)
    });

    if (branchLockAcquired && run.runType === RunType.implementation) {
      await redis.del(runLockKey(run.projectId, run.targetBranch));
    }
  }
}

async function runLoop(): Promise<void> {
  process.stdout.write("factory-runner-controller started\n");

  for (;;) {
    const item = await redis.brpop(runQueueKey(), POLL_TIMEOUT_SECONDS);
    if (!item) {
      continue;
    }

    const runId = item[1];
    try {
      await processRun(runId);
    } catch (error) {
      process.stderr.write(`run controller error for ${runId}: ${error}\n`);
    }
  }
}

runLoop().catch((error) => {
  process.stderr.write(`${error}\n`);
  process.exitCode = 1;
});
