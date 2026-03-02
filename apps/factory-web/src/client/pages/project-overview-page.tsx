import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "../components/ui/toast";

import {
  connectProjectRepo,
  getGitHubAppStatus,
  listAttractors,
  listEnvironments,
  listGitHubInstallationRepos,
  listProjectRuns,
  listProjects,
  listProjectSecrets,
  setProjectDefaultEnvironment,
  startGitHubAppInstallation,
  startGitHubAppManifestSetup,
  updateProjectRedeployDefaults
} from "../lib/api";
import { buildEffectiveAttractors } from "../lib/attractors-view";
import { getInactiveDefaultEnvironment, listActiveEnvironments } from "../lib/environments-view";
import { PageTitle } from "../components/layout/page-title";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

const NONE_SELECT_VALUE = "__none__";

function submitGitHubManifestForm(input: {
  manifestUrl: string;
  state: string;
  manifest: Record<string, unknown>;
}): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = input.manifestUrl;
  form.style.display = "none";

  const manifestField = document.createElement("input");
  manifestField.type = "hidden";
  manifestField.name = "manifest";
  manifestField.value = JSON.stringify(input.manifest);
  form.appendChild(manifestField);

  const stateField = document.createElement("input");
  stateField.type = "hidden";
  stateField.name = "state";
  stateField.value = input.state;
  form.appendChild(stateField);

  document.body.appendChild(form);
  form.submit();
}

export function ProjectOverviewPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId ?? "";
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const [installationId, setInstallationId] = useState("");
  const [repoFullName, setRepoFullName] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [selectedRepoFullName, setSelectedRepoFullName] = useState("");
  const [selectedDefaultEnvironmentId, setSelectedDefaultEnvironmentId] = useState("");
  const [redeployAttractorId, setRedeployAttractorId] = useState("");
  const [redeploySourceBranch, setRedeploySourceBranch] = useState("");
  const [redeployTargetBranch, setRedeployTargetBranch] = useState("");
  const [redeployEnvironmentId, setRedeployEnvironmentId] = useState("");

  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const githubAppStatusQuery = useQuery({ queryKey: ["github-app-status"], queryFn: getGitHubAppStatus });
  const runsQuery = useQuery({
    queryKey: ["project-runs", projectId],
    queryFn: () => listProjectRuns(projectId),
    enabled: projectId.length > 0
  });
  const attractorsQuery = useQuery({
    queryKey: ["attractors", projectId],
    queryFn: () => listAttractors(projectId),
    enabled: projectId.length > 0
  });
  const secretsQuery = useQuery({
    queryKey: ["project-secrets", projectId],
    queryFn: () => listProjectSecrets(projectId),
    enabled: projectId.length > 0
  });
  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: listEnvironments
  });

  const project = useMemo(
    () => projectsQuery.data?.find((candidate) => candidate.id === projectId),
    [projectsQuery.data, projectId]
  );

  const reposQuery = useQuery({
    queryKey: ["github-installation-repos", projectId],
    queryFn: () => listGitHubInstallationRepos(projectId),
    enabled: projectId.length > 0 && !!project?.githubInstallationId
  });

  const effectiveAttractors = useMemo(
    () => buildEffectiveAttractors(attractorsQuery.data ?? []),
    [attractorsQuery.data]
  );
  const effectiveAttractorCount = effectiveAttractors.length;
  const redeployAttractorOptions = useMemo(
    () => effectiveAttractors.filter((attractor) => attractor.active && !!attractor.contentPath),
    [effectiveAttractors]
  );
  const installationRepos = reposQuery.data?.repos ?? [];

  const connectMutation = useMutation({
    mutationFn: (input: { installationId: string; repoFullName: string; defaultBranch: string }) =>
      connectProjectRepo(projectId, input),
    onSuccess: () => {
      toast.success("Repository connection saved");
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["github-installation-repos", projectId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const createAppMutation = useMutation({
    mutationFn: () => startGitHubAppManifestSetup(projectId),
    onSuccess: (payload) => {
      submitGitHubManifestForm(payload);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const installAppMutation = useMutation({
    mutationFn: () => startGitHubAppInstallation(projectId),
    onSuccess: (payload) => {
      window.location.assign(payload.installationUrl);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const setDefaultEnvironmentMutation = useMutation({
    mutationFn: (environmentId: string) => setProjectDefaultEnvironment(projectId, environmentId),
    onSuccess: () => {
      toast.success("Default environment updated");
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["project-runs", projectId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const redeployDefaultsMutation = useMutation({
    mutationFn: () =>
      updateProjectRedeployDefaults(projectId, {
        redeployAttractorId: redeployAttractorId.trim().length > 0 ? redeployAttractorId.trim() : null,
        redeploySourceBranch:
          redeploySourceBranch.trim().length > 0 ? redeploySourceBranch.trim() : null,
        redeployTargetBranch:
          redeployTargetBranch.trim().length > 0 ? redeployTargetBranch.trim() : null,
        redeployEnvironmentId:
          redeployEnvironmentId.trim().length > 0 ? redeployEnvironmentId.trim() : null
      }),
    onSuccess: () => {
      toast.success("Redeploy defaults saved");
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const defaultEnvironment = (environmentsQuery.data ?? []).find(
    (environment) => environment.id === project?.defaultEnvironmentId
  );
  const activeEnvironments = listActiveEnvironments(environmentsQuery.data ?? []);
  const inactiveDefaultEnvironment = getInactiveDefaultEnvironment(project, environmentsQuery.data ?? []);
  const effectiveDefaultEnvironmentId =
    selectedDefaultEnvironmentId || (defaultEnvironment?.active ? defaultEnvironment.id : "");

  useEffect(() => {
    if (!project) {
      return;
    }
    if (!installationId && project.githubInstallationId) {
      setInstallationId(project.githubInstallationId);
    }
    if (!repoFullName && project.repoFullName) {
      setRepoFullName(project.repoFullName);
      setSelectedRepoFullName(project.repoFullName);
    }
    if ((defaultBranch === "main" || !defaultBranch) && project.defaultBranch) {
      setDefaultBranch(project.defaultBranch);
    }
    if (!redeployAttractorId && project.redeployAttractorId) {
      setRedeployAttractorId(project.redeployAttractorId);
    }
    if (!redeploySourceBranch && project.redeploySourceBranch) {
      setRedeploySourceBranch(project.redeploySourceBranch);
    }
    if (!redeployTargetBranch && project.redeployTargetBranch) {
      setRedeployTargetBranch(project.redeployTargetBranch);
    }
    if (!redeployEnvironmentId && project.redeployEnvironmentId) {
      setRedeployEnvironmentId(project.redeployEnvironmentId);
    }
  }, [project, installationId, repoFullName, defaultBranch]);

  useEffect(() => {
    const linked = searchParams.get("githubLinked");
    const error = searchParams.get("githubAppError");
    const callbackInstallationId = searchParams.get("installationId");

    if (!linked && !error && !callbackInstallationId) {
      return;
    }

    if (callbackInstallationId?.trim()) {
      setInstallationId(callbackInstallationId.trim());
    }
    if (linked === "1") {
      toast.success("GitHub App installation linked");
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["github-installation-repos", projectId] });
    }
    if (error) {
      toast.error(error);
    }

    const cleaned = new URLSearchParams(searchParams);
    cleaned.delete("githubLinked");
    cleaned.delete("githubAppError");
    cleaned.delete("installationId");
    setSearchParams(cleaned, { replace: true });
  }, [projectId, queryClient, searchParams, setSearchParams]);

  if (!project) {
    return <p className="text-sm text-muted-foreground">Project not found.</p>;
  }

  return (
    <div>
      <PageTitle
        title={project.name}
        description={`Namespace: ${project.namespace}`}
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link to={`/projects/${project.id}/environments`}>Manage Environments</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={`/projects/${project.id}/runs`}>Start Run</Link>
            </Button>
          </div>
        }
      />

      {inactiveDefaultEnvironment ? (
        <Card className="mb-4 border-destructive/60">
          <CardHeader>
            <CardTitle className="text-destructive">Default environment is inactive</CardTitle>
            <CardDescription>
              <span className="mono">{inactiveDefaultEnvironment.name}</span> is inactive. Select an active environment below.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Runs</CardDescription>
            <CardTitle>{runsQuery.data?.length ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Attractors</CardDescription>
            <CardTitle>{effectiveAttractorCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Project Secrets</CardDescription>
            <CardTitle>{secretsQuery.data?.length ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Default Environment</CardDescription>
            <CardTitle>{defaultEnvironment?.name ?? "Not configured"}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[2fr,1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Repository Connection</CardTitle>
            <CardDescription>Create/install a GitHub App, then connect a repository for this project.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border border-border p-3">
              <p className="text-sm">
                <span className="text-muted-foreground">GitHub App:</span>{" "}
                {githubAppStatusQuery.data?.configured
                  ? `configured (${githubAppStatusQuery.data.source})`
                  : "not configured"}
              </p>
              <p className="text-sm">
                <span className="text-muted-foreground">Installation:</span> {project.githubInstallationId ?? "not linked"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => createAppMutation.mutate()}
                  disabled={createAppMutation.isPending}
                >
                  {createAppMutation.isPending ? "Opening GitHub..." : "Create GitHub App"}
                </Button>
                <Button
                  type="button"
                  onClick={() => installAppMutation.mutate()}
                  disabled={installAppMutation.isPending}
                >
                  {installAppMutation.isPending ? "Opening GitHub..." : "Install / Link App"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void queryClient.invalidateQueries({ queryKey: ["github-installation-repos", projectId] })}
                  disabled={reposQuery.isFetching || !project.githubInstallationId}
                >
                  {reposQuery.isFetching ? "Refreshing..." : "Refresh Repositories"}
                </Button>
              </div>
            </div>

            <form
              className="grid gap-3 md:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                const effectiveInstallationId = installationId.trim() || project.githubInstallationId?.trim() || "";
                if (!effectiveInstallationId || !repoFullName.trim() || !defaultBranch.trim()) {
                  toast.error("Installation ID, repository, and default branch are required");
                  return;
                }
                connectMutation.mutate({
                  installationId: effectiveInstallationId,
                  repoFullName: repoFullName.trim(),
                  defaultBranch: defaultBranch.trim()
                });
              }}
            >
              {installationRepos.length > 0 ? (
                <div className="space-y-1 md:col-span-2">
                  <Label>Repository from Installation</Label>
                  <Select
                    value={selectedRepoFullName || undefined}
                    onValueChange={(value) => {
                      setSelectedRepoFullName(value);
                      setRepoFullName(value);
                      const selected = installationRepos.find((repo) => repo.fullName === value);
                      if (selected?.defaultBranch) {
                        setDefaultBranch(selected.defaultBranch);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select repository" />
                    </SelectTrigger>
                    <SelectContent>
                      {installationRepos.map((repo) => (
                        <SelectItem key={repo.id} value={repo.fullName}>
                          {repo.fullName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="space-y-1">
                <Label htmlFor="installation-id">Installation ID</Label>
                <Input
                  id="installation-id"
                  value={installationId}
                  onChange={(event) => setInstallationId(event.target.value)}
                  placeholder={project.githubInstallationId ?? "123456"}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="repo-name">Repository</Label>
                <Input
                  id="repo-name"
                  value={repoFullName}
                  onChange={(event) => {
                    setRepoFullName(event.target.value);
                    setSelectedRepoFullName(event.target.value);
                  }}
                  placeholder={project.repoFullName ?? "owner/repo"}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="default-branch">Default Branch</Label>
                <Input
                  id="default-branch"
                  value={defaultBranch}
                  onChange={(event) => setDefaultBranch(event.target.value)}
                  placeholder={project.defaultBranch ?? "main"}
                />
              </div>
              <div className="flex items-end">
                <Button type="submit" disabled={connectMutation.isPending}>
                  {connectMutation.isPending ? "Saving..." : "Save Connection"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Context</CardTitle>
            <CardDescription>Current project metadata.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">Repo:</span> {project.repoFullName ?? "Not connected"}
            </p>
            <p>
              <span className="text-muted-foreground">Default branch:</span> {project.defaultBranch ?? "-"}
            </p>
            <p>
              <span className="text-muted-foreground">GitHub installation:</span> {project.githubInstallationId ?? "-"}
            </p>
            <p>
              <span className="text-muted-foreground">GitHub App:</span> {githubAppStatusQuery.data?.appSlug ?? "Not configured"}
            </p>
            <p>
              <span className="text-muted-foreground">Environment:</span> {defaultEnvironment?.name ?? "-"}
            </p>
            <p>
              <span className="text-muted-foreground">Redeploy attractor:</span>{" "}
              {redeployAttractorOptions.find((item) => item.id === project.redeployAttractorId)?.name ??
                project.redeployAttractorId ??
                "-"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Execution Environment</CardTitle>
            <CardDescription>Select the default runtime environment for new runs.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label>Default Environment</Label>
              <Select
                value={effectiveDefaultEnvironmentId || undefined}
                onValueChange={setSelectedDefaultEnvironmentId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select environment" />
                </SelectTrigger>
                <SelectContent>
                  {activeEnvironments.map((environment) => (
                    <SelectItem key={environment.id} value={environment.id}>
                      {environment.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={() => {
                if (!effectiveDefaultEnvironmentId) {
                  toast.error("Select an environment first");
                  return;
                }
                setDefaultEnvironmentMutation.mutate(effectiveDefaultEnvironmentId);
              }}
              disabled={setDefaultEnvironmentMutation.isPending || !effectiveDefaultEnvironmentId}
            >
              {setDefaultEnvironmentMutation.isPending ? "Saving..." : "Save Default Environment"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Redeploy Defaults</CardTitle>
            <CardDescription>
              Used by Project Chat command <span className="mono">redeploy this project</span>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label>Attractor</Label>
              <Select
                value={redeployAttractorId || NONE_SELECT_VALUE}
                onValueChange={(value) =>
                  setRedeployAttractorId(value === NONE_SELECT_VALUE ? "" : value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select attractor" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_SELECT_VALUE}>No attractor selected</SelectItem>
                  {redeployAttractorOptions.map((attractor) => (
                    <SelectItem key={attractor.id} value={attractor.id}>
                      {attractor.scope === "PROJECT" ? attractor.name : `${attractor.name} (global)`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="redeploy-source-branch">Source Branch</Label>
              <Input
                id="redeploy-source-branch"
                value={redeploySourceBranch}
                onChange={(event) => setRedeploySourceBranch(event.target.value)}
                placeholder={project.defaultBranch ?? "main"}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="redeploy-target-branch">Target Branch</Label>
              <Input
                id="redeploy-target-branch"
                value={redeployTargetBranch}
                onChange={(event) => setRedeployTargetBranch(event.target.value)}
                placeholder="attractor/redeploy"
              />
            </div>
            <div className="space-y-1">
              <Label>Environment (Optional)</Label>
              <Select
                value={redeployEnvironmentId || NONE_SELECT_VALUE}
                onValueChange={(value) =>
                  setRedeployEnvironmentId(value === NONE_SELECT_VALUE ? "" : value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Use project default environment" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_SELECT_VALUE}>Use project default environment</SelectItem>
                  {activeEnvironments.map((environment) => (
                    <SelectItem key={environment.id} value={environment.id}>
                      {environment.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={() => {
                if (!redeployAttractorId.trim() || !redeploySourceBranch.trim() || !redeployTargetBranch.trim()) {
                  toast.error("Attractor, source branch, and target branch are required");
                  return;
                }
                redeployDefaultsMutation.mutate();
              }}
              disabled={redeployDefaultsMutation.isPending}
            >
              {redeployDefaultsMutation.isPending ? "Saving..." : "Save Redeploy Defaults"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
