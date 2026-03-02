import type {
  AgentAction,
  AgentMessage,
  AgentScope,
  AgentSession,
  Artifact,
  ArtifactContentResponse,
  AttractorDef,
  AttractorValidation,
  AttractorVersion,
  Environment,
  EnvironmentShellSession,
  EnvironmentShellSessionRequest,
  EnvironmentResources,
  GitHubAppStatus,
  GitHubIssue,
  GitHubInstallationRepo,
  GitHubPullLaunchDefaults,
  GitHubPullQueueItem,
  GitHubPullRequest,
  GlobalTaskTemplate,
  GlobalAttractor,
  GlobalSecret,
  Project,
  ProjectSecret,
  ProviderSchema,
  Run,
  RunQuestion,
  RunReviewChecklist,
  RunReviewResponse,
  RunModelConfig,
  TaskTemplate,
  TaskTemplateEventLedgerRecord,
  TaskTemplateTriggerRule,
  SpecBundle
} from "./types";

const DEFAULT_API_BASE = "/api";

export function getApiBase(): string {
  const configBase = window.__FACTORY_APP_CONFIG__?.apiBaseUrl;
  const envBase = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_API_BASE_URL;
  return (configBase ?? envBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}

export function buildApiUrl(path: string): string {
  const base = getApiBase();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/api") && normalizedPath.startsWith("/api/")) {
    return `${base}${normalizedPath.slice(4)}`;
  }
  return `${base}${normalizedPath}`;
}

export function buildWebSocketUrl(path: string): string {
  const httpUrl = buildApiUrl(path);
  if (httpUrl.startsWith("https://")) {
    return `wss://${httpUrl.slice("https://".length)}`;
  }
  if (httpUrl.startsWith("http://")) {
    return `ws://${httpUrl.slice("http://".length)}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${httpUrl}`;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      const safeReturnTo = returnTo.startsWith("/") ? returnTo : "/";
      window.location.assign(`/auth/google/start?returnTo=${encodeURIComponent(safeReturnTo)}`);
    }
    const errorMessage =
      typeof payload?.error === "string" ? payload.error : `${response.status} ${response.statusText}`;
    throw new Error(errorMessage);
  }
  return payload as T;
}

export function artifactDownloadUrl(runId: string, artifactId: string): string {
  return buildApiUrl(`/api/runs/${runId}/artifacts/${artifactId}/download`);
}

export async function listProjects(): Promise<Project[]> {
  const payload = await apiRequest<{ projects: Project[] }>("/api/projects");
  return payload.projects;
}

export async function updateProjectRedeployDefaults(
  projectId: string,
  input: {
    redeployAttractorId?: string | null;
    redeploySourceBranch?: string | null;
    redeployTargetBranch?: string | null;
    redeployEnvironmentId?: string | null;
  }
): Promise<Project> {
  return apiRequest<Project>(`/api/projects/${projectId}/redeploy-defaults`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export async function listAgentSessions(input: {
  scope: AgentScope;
  projectId?: string;
  limit?: number;
}): Promise<AgentSession[]> {
  const query = new URLSearchParams();
  query.set("scope", input.scope);
  if (input.projectId) {
    query.set("projectId", input.projectId);
  }
  if (input.limit) {
    query.set("limit", String(input.limit));
  }
  const payload = await apiRequest<{ sessions: AgentSession[] }>(
    `/api/agent/sessions?${query.toString()}`
  );
  return payload.sessions;
}

export async function createAgentSession(input: {
  scope: AgentScope;
  projectId?: string;
  title?: string;
}): Promise<AgentSession> {
  const payload = await apiRequest<{ session: AgentSession }>("/api/agent/sessions", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return payload.session;
}

export async function getAgentSession(sessionId: string): Promise<AgentSession> {
  const payload = await apiRequest<{ session: AgentSession }>(`/api/agent/sessions/${sessionId}`);
  return payload.session;
}

export async function archiveAgentSession(sessionId: string): Promise<void> {
  await apiRequest<unknown>(`/api/agent/sessions/${sessionId}`, {
    method: "DELETE"
  });
}

export async function listAgentSessionMessages(
  sessionId: string,
  limit?: number
): Promise<{ messages: AgentMessage[]; actions: AgentAction[] }> {
  const query = new URLSearchParams();
  if (limit) {
    query.set("limit", String(limit));
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return apiRequest<{ messages: AgentMessage[]; actions: AgentAction[] }>(
    `/api/agent/sessions/${sessionId}/messages${suffix}`
  );
}

export async function postAgentMessage(
  sessionId: string,
  content: string
): Promise<{
  userMessage: AgentMessage;
  assistantMessage: AgentMessage;
  pendingActions: AgentAction[];
}> {
  return apiRequest<{
    userMessage: AgentMessage;
    assistantMessage: AgentMessage;
    pendingActions: AgentAction[];
  }>(`/api/agent/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content })
  });
}

export async function approveAgentAction(
  sessionId: string,
  actionId: string
): Promise<{ action: AgentAction; assistantMessage: AgentMessage }> {
  return apiRequest<{ action: AgentAction; assistantMessage: AgentMessage }>(
    `/api/agent/sessions/${sessionId}/actions/${actionId}/approve`,
    { method: "POST" }
  );
}

export async function rejectAgentAction(
  sessionId: string,
  actionId: string
): Promise<{ action: AgentAction; assistantMessage: AgentMessage }> {
  return apiRequest<{ action: AgentAction; assistantMessage: AgentMessage }>(
    `/api/agent/sessions/${sessionId}/actions/${actionId}/reject`,
    { method: "POST" }
  );
}

export async function connectProjectRepo(
  projectId: string,
  input: { installationId: string; repoFullName: string; defaultBranch: string }
): Promise<Project> {
  return apiRequest<Project>(`/api/projects/${projectId}/repo/connect/github`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function getGitHubAppStatus(): Promise<GitHubAppStatus> {
  return apiRequest<GitHubAppStatus>("/api/github/app/status");
}

export async function startGitHubAppManifestSetup(projectId: string): Promise<{
  manifestUrl: string;
  state: string;
  manifest: Record<string, unknown>;
}> {
  return apiRequest<{
    manifestUrl: string;
    state: string;
    manifest: Record<string, unknown>;
  }>(`/api/github/app/manifest/start?projectId=${encodeURIComponent(projectId)}`);
}

export async function startGitHubAppInstallation(projectId: string): Promise<{
  installationUrl: string;
  appSlug: string;
}> {
  return apiRequest<{ installationUrl: string; appSlug: string }>(
    `/api/github/app/start?projectId=${encodeURIComponent(projectId)}`
  );
}

export async function listGitHubInstallationRepos(
  projectId: string
): Promise<{ repos: GitHubInstallationRepo[]; installationId: string }> {
  return apiRequest<{ repos: GitHubInstallationRepo[]; installationId: string }>(
    `/api/projects/${projectId}/github/repos`
  );
}

export async function reconcileProjectGitHub(
  projectId: string
): Promise<{ projectId: string; issuesSynced: number; pullRequestsSynced: number }> {
  return apiRequest<{ projectId: string; issuesSynced: number; pullRequestsSynced: number }>(
    `/api/projects/${projectId}/github/reconcile`,
    {
      method: "POST"
    }
  );
}

export async function listProjectGitHubIssues(
  projectId: string,
  input?: { state?: "open" | "closed" | "all"; q?: string; limit?: number }
): Promise<GitHubIssue[]> {
  const query = new URLSearchParams();
  if (input?.state) {
    query.set("state", input.state);
  }
  if (input?.q) {
    query.set("q", input.q);
  }
  if (input?.limit) {
    query.set("limit", String(input.limit));
  }
  const payload = await apiRequest<{ issues: GitHubIssue[] }>(
    `/api/projects/${projectId}/github/issues${query.toString() ? `?${query}` : ""}`
  );
  return payload.issues;
}

export async function getProjectGitHubIssue(
  projectId: string,
  issueNumber: number
): Promise<{
  issue: GitHubIssue;
  runs: Run[];
  pullRequests: GitHubPullRequest[];
  launchDefaults: {
    sourceBranch: string;
    targetBranch: string;
    attractorOptions: Array<{
      id: string;
      name: string;
      defaultRunType: "planning" | "implementation" | "task";
      modelConfig: RunModelConfig | null;
    }>;
  };
}> {
  return apiRequest(`/api/projects/${projectId}/github/issues/${issueNumber}`);
}

export async function listProjectGitHubPulls(
  projectId: string,
  input?: { state?: "open" | "closed" | "all"; limit?: number }
): Promise<GitHubPullQueueItem[]> {
  const query = new URLSearchParams();
  if (input?.state) {
    query.set("state", input.state);
  }
  if (input?.limit) {
    query.set("limit", String(input.limit));
  }
  const payload = await apiRequest<{ pulls: GitHubPullQueueItem[] }>(
    `/api/projects/${projectId}/github/pulls${query.toString() ? `?${query}` : ""}`
  );
  return payload.pulls;
}

export async function getProjectGitHubPull(
  projectId: string,
  prNumber: number
): Promise<{ pull: GitHubPullQueueItem; launchDefaults: GitHubPullLaunchDefaults }> {
  return apiRequest(`/api/projects/${projectId}/github/pulls/${prNumber}`);
}

export async function launchPullRequestReviewRun(
  projectId: string,
  prNumber: number,
  input: {
    attractorDefId: string;
    environmentId?: string;
    sourceBranch?: string;
    targetBranch?: string;
  }
): Promise<{
  runId: string;
  status: string;
  sourceBranch: string;
  targetBranch: string;
  githubPullRequest: {
    id: string;
    prNumber: number;
    url: string;
    headSha: string;
  } | null;
}> {
  return apiRequest(`/api/projects/${projectId}/github/pulls/${prNumber}/runs`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function launchIssueRun(
  projectId: string,
  issueNumber: number,
  input: {
    attractorDefId: string;
    environmentId?: string;
    runType: "planning" | "implementation" | "task";
    sourceBranch?: string;
    targetBranch?: string;
    specBundleId?: string;
    force?: boolean;
  }
): Promise<{
  runId: string;
  status: string;
  sourceBranch: string;
  targetBranch: string;
  githubIssue: GitHubIssue;
}> {
  return apiRequest(
    `/api/projects/${projectId}/github/issues/${issueNumber}/runs`,
    {
      method: "POST",
      body: JSON.stringify(input)
    }
  );
}

export async function createProject(input: {
  name: string;
  namespace?: string;
  defaultEnvironmentId?: string;
}): Promise<Project> {
  return apiRequest<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function listEnvironments(): Promise<Environment[]> {
  const payload = await apiRequest<{ environments: Environment[] }>("/api/environments");
  return payload.environments;
}

export async function createEnvironment(input: {
  name: string;
  kind?: "KUBERNETES_JOB";
  runnerImage: string;
  setupScript?: string;
  serviceAccountName?: string;
  resourcesJson?: EnvironmentResources;
  active?: boolean;
}): Promise<Environment> {
  return apiRequest<Environment>("/api/environments", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function updateEnvironment(
  environmentId: string,
  input: {
    name?: string;
    runnerImage?: string;
    setupScript?: string | null;
    serviceAccountName?: string | null;
    resourcesJson?: EnvironmentResources | null;
    active?: boolean;
  }
): Promise<Environment> {
  return apiRequest<Environment>(`/api/environments/${environmentId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export async function createEnvironmentShellSession(
  environmentId: string,
  input: EnvironmentShellSessionRequest
): Promise<EnvironmentShellSession> {
  const payload = await apiRequest<{ session: EnvironmentShellSession }>(
    `/api/environments/${environmentId}/shell/sessions`,
    {
      method: "POST",
      body: JSON.stringify(input)
    }
  );
  return payload.session;
}

export async function terminateEnvironmentShellSession(sessionId: string): Promise<void> {
  await apiRequest<unknown>(`/api/environments/shell/sessions/${sessionId}`, {
    method: "DELETE"
  });
}

export async function setProjectDefaultEnvironment(
  projectId: string,
  environmentId: string
): Promise<Project> {
  return apiRequest<Project>(`/api/projects/${projectId}/environment`, {
    method: "POST",
    body: JSON.stringify({ environmentId })
  });
}

export async function bootstrapSelf(input: {
  repoFullName: string;
  defaultBranch: string;
  attractorPath: string;
}): Promise<{ project: Project; attractor: AttractorDef }> {
  return apiRequest<{ project: Project; attractor: AttractorDef }>("/api/bootstrap/self", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function listProviders(): Promise<string[]> {
  const payload = await apiRequest<{ providers: string[] }>("/api/models/providers");
  return payload.providers;
}

export async function listModels(provider: string): Promise<Array<{ id: string; name: string; provider: string; api: string }>> {
  const payload = await apiRequest<{
    provider: string;
    models: Array<{ id: string; name: string; provider: string; api: string }>;
  }>(`/api/models?provider=${encodeURIComponent(provider)}`);
  return payload.models;
}

export async function listProviderSchemas(): Promise<ProviderSchema[]> {
  const payload = await apiRequest<{ providers: ProviderSchema[] }>("/api/secrets/providers");
  return payload.providers;
}

export async function listGlobalSecrets(): Promise<GlobalSecret[]> {
  const payload = await apiRequest<{ secrets: GlobalSecret[] }>("/api/secrets/global");
  return payload.secrets;
}

export async function getGlobalSecretValues(secretId: string): Promise<Record<string, string>> {
  const payload = await apiRequest<{ values: Record<string, string> }>(`/api/secrets/global/${secretId}/values`);
  return payload.values;
}

export async function upsertGlobalSecret(input: {
  name: string;
  provider?: string;
  keyMappings?: Record<string, string>;
  values: Record<string, string>;
}): Promise<GlobalSecret> {
  return apiRequest<GlobalSecret>("/api/secrets/global", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function listProjectSecrets(projectId: string): Promise<ProjectSecret[]> {
  const payload = await apiRequest<{ secrets: ProjectSecret[] }>(`/api/projects/${projectId}/secrets`);
  return payload.secrets;
}

export async function getProjectSecretValues(projectId: string, secretId: string): Promise<Record<string, string>> {
  const payload = await apiRequest<{ values: Record<string, string> }>(
    `/api/projects/${projectId}/secrets/${secretId}/values`
  );
  return payload.values;
}

export async function upsertProjectSecret(
  projectId: string,
  input: {
    name: string;
    provider?: string;
    keyMappings?: Record<string, string>;
    values: Record<string, string>;
  }
): Promise<ProjectSecret> {
  return apiRequest<ProjectSecret>(`/api/projects/${projectId}/secrets`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function listAttractors(projectId: string): Promise<AttractorDef[]> {
  const payload = await apiRequest<{ attractors: AttractorDef[] }>(`/api/projects/${projectId}/attractors`);
  return payload.attractors;
}

export async function listGlobalAttractors(): Promise<GlobalAttractor[]> {
  const payload = await apiRequest<{ attractors: GlobalAttractor[] }>("/api/attractors/global");
  return payload.attractors;
}

export async function getGlobalAttractor(
  attractorId: string
): Promise<{ attractor: GlobalAttractor; content: string | null; validation: AttractorValidation }> {
  return apiRequest<{ attractor: GlobalAttractor; content: string | null; validation: AttractorValidation }>(
    `/api/attractors/global/${attractorId}`
  );
}

export async function listGlobalAttractorVersions(attractorId: string): Promise<AttractorVersion[]> {
  const payload = await apiRequest<{ versions: AttractorVersion[] }>(`/api/attractors/global/${attractorId}/versions`);
  return payload.versions;
}

export async function getGlobalAttractorVersion(
  attractorId: string,
  version: number
): Promise<{ version: AttractorVersion; content: string | null; validation: AttractorValidation }> {
  return apiRequest<{ version: AttractorVersion; content: string | null; validation: AttractorValidation }>(
    `/api/attractors/global/${attractorId}/versions/${version}`
  );
}

export async function upsertGlobalAttractor(input: {
  name: string;
  content: string;
  repoPath?: string;
  defaultRunType: "planning" | "implementation" | "task";
  modelConfig: RunModelConfig;
  description?: string;
  active?: boolean;
}): Promise<GlobalAttractor> {
  return apiRequest<GlobalAttractor>("/api/attractors/global", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function updateGlobalAttractor(
  attractorId: string,
  input: {
    expectedContentVersion?: number;
    name?: string;
    content?: string;
    repoPath?: string | null;
    defaultRunType?: "planning" | "implementation" | "task";
    modelConfig?: RunModelConfig | null;
    description?: string | null;
    active?: boolean;
  }
): Promise<{ attractor: GlobalAttractor; content: string | null; validation: AttractorValidation }> {
  return apiRequest<{ attractor: GlobalAttractor; content: string | null; validation: AttractorValidation }>(
    `/api/attractors/global/${attractorId}`,
    {
      method: "PATCH",
      body: JSON.stringify(input)
    }
  );
}

export async function createAttractor(
  projectId: string,
  input: {
    name: string;
    content: string;
    repoPath?: string;
    defaultRunType: "planning" | "implementation" | "task";
    modelConfig: RunModelConfig;
    description?: string;
    active?: boolean;
  }
): Promise<AttractorDef> {
  return apiRequest<AttractorDef>(`/api/projects/${projectId}/attractors`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function getProjectAttractor(
  projectId: string,
  attractorId: string
): Promise<{ attractor: AttractorDef; content: string | null; validation: AttractorValidation }> {
  return apiRequest<{ attractor: AttractorDef; content: string | null; validation: AttractorValidation }>(
    `/api/projects/${projectId}/attractors/${attractorId}`
  );
}

export async function listProjectAttractorVersions(
  projectId: string,
  attractorId: string
): Promise<AttractorVersion[]> {
  const payload = await apiRequest<{ versions: AttractorVersion[] }>(
    `/api/projects/${projectId}/attractors/${attractorId}/versions`
  );
  return payload.versions;
}

export async function getProjectAttractorVersion(
  projectId: string,
  attractorId: string,
  version: number
): Promise<{ version: AttractorVersion; content: string | null; validation: AttractorValidation }> {
  return apiRequest<{ version: AttractorVersion; content: string | null; validation: AttractorValidation }>(
    `/api/projects/${projectId}/attractors/${attractorId}/versions/${version}`
  );
}

export async function updateProjectAttractor(
  projectId: string,
  attractorId: string,
  input: {
    expectedContentVersion?: number;
    name?: string;
    content?: string;
    repoPath?: string | null;
    defaultRunType?: "planning" | "implementation" | "task";
    modelConfig?: RunModelConfig | null;
    description?: string | null;
    active?: boolean;
  }
): Promise<{ attractor: AttractorDef; content: string | null; validation: AttractorValidation }> {
  return apiRequest<{ attractor: AttractorDef; content: string | null; validation: AttractorValidation }>(
    `/api/projects/${projectId}/attractors/${attractorId}`,
    {
      method: "PATCH",
      body: JSON.stringify(input)
    }
  );
}

export async function listGlobalTaskTemplates(): Promise<GlobalTaskTemplate[]> {
  const payload = await apiRequest<{ templates: GlobalTaskTemplate[] }>("/api/task-templates/global");
  return payload.templates;
}

export async function createGlobalTaskTemplate(input: {
  name: string;
  attractorName: string;
  runType: "planning" | "implementation" | "task";
  sourceBranch?: string;
  targetBranch?: string;
  environmentMode?: "PROJECT_DEFAULT" | "NAMED";
  environmentName?: string | null;
  scheduleEnabled?: boolean;
  scheduleCron?: string | null;
  scheduleTimezone?: string | null;
  triggers?: TaskTemplateTriggerRule[];
  description?: string | null;
  active?: boolean;
}): Promise<GlobalTaskTemplate> {
  return apiRequest<GlobalTaskTemplate>("/api/task-templates/global", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function getGlobalTaskTemplate(templateId: string): Promise<GlobalTaskTemplate> {
  const payload = await apiRequest<{ template: GlobalTaskTemplate }>(`/api/task-templates/global/${templateId}`);
  return payload.template;
}

export async function updateGlobalTaskTemplate(
  templateId: string,
  input: {
    name?: string;
    attractorName?: string;
    runType?: "planning" | "implementation" | "task";
    sourceBranch?: string | null;
    targetBranch?: string | null;
    environmentMode?: "PROJECT_DEFAULT" | "NAMED";
    environmentName?: string | null;
    scheduleEnabled?: boolean;
    scheduleCron?: string | null;
    scheduleTimezone?: string | null;
    triggers?: TaskTemplateTriggerRule[];
    description?: string | null;
    active?: boolean;
  }
): Promise<GlobalTaskTemplate> {
  const payload = await apiRequest<{ template: GlobalTaskTemplate }>(`/api/task-templates/global/${templateId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
  return payload.template;
}

export async function listProjectTaskTemplates(projectId: string): Promise<TaskTemplate[]> {
  const payload = await apiRequest<{ templates: TaskTemplate[] }>(`/api/projects/${projectId}/task-templates`);
  return payload.templates;
}

export async function createProjectTaskTemplate(
  projectId: string,
  input: {
    name: string;
    attractorName: string;
    runType: "planning" | "implementation" | "task";
    sourceBranch?: string;
    targetBranch?: string;
    environmentMode?: "PROJECT_DEFAULT" | "NAMED";
    environmentName?: string | null;
    scheduleEnabled?: boolean;
    scheduleCron?: string | null;
    scheduleTimezone?: string | null;
    triggers?: TaskTemplateTriggerRule[];
    description?: string | null;
    active?: boolean;
  }
): Promise<TaskTemplate> {
  const payload = await apiRequest<{ template: TaskTemplate }>(`/api/projects/${projectId}/task-templates`, {
    method: "POST",
    body: JSON.stringify(input)
  });
  return payload.template;
}

export async function getProjectTaskTemplate(projectId: string, templateId: string): Promise<TaskTemplate> {
  const payload = await apiRequest<{ template: TaskTemplate }>(
    `/api/projects/${projectId}/task-templates/${templateId}`
  );
  return payload.template;
}

export async function updateProjectTaskTemplate(
  projectId: string,
  templateId: string,
  input: {
    name?: string;
    attractorName?: string;
    runType?: "planning" | "implementation" | "task";
    sourceBranch?: string | null;
    targetBranch?: string | null;
    environmentMode?: "PROJECT_DEFAULT" | "NAMED";
    environmentName?: string | null;
    scheduleEnabled?: boolean;
    scheduleCron?: string | null;
    scheduleTimezone?: string | null;
    triggers?: TaskTemplateTriggerRule[];
    description?: string | null;
    active?: boolean;
  }
): Promise<TaskTemplate> {
  const payload = await apiRequest<{ template: TaskTemplate }>(
    `/api/projects/${projectId}/task-templates/${templateId}`,
    {
      method: "PATCH",
      body: JSON.stringify(input)
    }
  );
  return payload.template;
}

export async function launchProjectTaskTemplateRun(
  projectId: string,
  templateId: string,
  input?: { force?: boolean; specBundleId?: string }
): Promise<{ runId: string; status: string }> {
  return apiRequest<{ runId: string; status: string }>(
    `/api/projects/${projectId}/task-templates/${templateId}/runs`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {})
    }
  );
}

export async function listProjectTaskTemplateEvents(
  projectId: string
): Promise<Array<TaskTemplateEventLedgerRecord & { taskTemplate?: { id: string; name: string; scope: string } }>> {
  const payload = await apiRequest<{
    events: Array<TaskTemplateEventLedgerRecord & { taskTemplate?: { id: string; name: string; scope: string } }>;
  }>(`/api/projects/${projectId}/task-templates/events`);
  return payload.events;
}

export async function replayProjectTaskTemplateEvent(
  projectId: string,
  eventId: string
): Promise<{ runId: string; status: string }> {
  return apiRequest<{ runId: string; status: string }>(
    `/api/projects/${projectId}/task-templates/events/${eventId}/replay`,
    {
      method: "POST"
    }
  );
}

export async function listProjectRuns(projectId: string): Promise<Run[]> {
  const payload = await apiRequest<{ runs: Run[] }>(`/api/projects/${projectId}/runs`);
  return payload.runs;
}

export async function createRun(input: {
  projectId: string;
  attractorDefId: string;
  environmentId?: string;
  runType: "planning" | "implementation" | "task";
  sourceBranch: string;
  targetBranch: string;
  specBundleId?: string;
}): Promise<{ runId: string; status: string }> {
  return apiRequest<{ runId: string; status: string }>("/api/runs", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function getRun(runId: string): Promise<Run> {
  return apiRequest<Run>(`/api/runs/${runId}`);
}

export async function cancelRun(runId: string): Promise<{ runId: string; status: string }> {
  return apiRequest<{ runId: string; status: string }>(`/api/runs/${runId}/cancel`, {
    method: "POST"
  });
}

export async function getRunQuestions(runId: string): Promise<RunQuestion[]> {
  const payload = await apiRequest<{ questions: RunQuestion[] }>(`/api/runs/${runId}/questions`);
  return payload.questions;
}

export async function answerRunQuestion(
  runId: string,
  questionId: string,
  input: { answer: string }
): Promise<{ question: RunQuestion }> {
  return apiRequest<{ question: RunQuestion }>(`/api/runs/${runId}/questions/${questionId}/answer`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function getRunArtifacts(runId: string): Promise<{ artifacts: Artifact[]; specBundle: SpecBundle | null }> {
  return apiRequest<{ artifacts: Artifact[]; specBundle: SpecBundle | null }>(`/api/runs/${runId}/artifacts`);
}

export async function getArtifactContent(runId: string, artifactId: string): Promise<ArtifactContentResponse> {
  return apiRequest<ArtifactContentResponse>(`/api/runs/${runId}/artifacts/${artifactId}/content`);
}

export async function getRunReview(runId: string): Promise<RunReviewResponse> {
  return apiRequest<RunReviewResponse>(`/api/runs/${runId}/review`);
}

export async function upsertRunReview(
  runId: string,
  input: {
    reviewer: string;
    decision: "APPROVE" | "REQUEST_CHANGES" | "REJECT" | "EXCEPTION";
    checklist: RunReviewChecklist;
    summary?: string;
    criticalFindings?: string;
    artifactFindings?: string;
    attestation?: string;
  }
): Promise<{ review: RunReviewResponse["review"] }> {
  return apiRequest<{ review: RunReviewResponse["review"] }>(`/api/runs/${runId}/review`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}
