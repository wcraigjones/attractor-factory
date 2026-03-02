import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  getProjectGitHubPull,
  launchPullRequestReviewRun,
  listEnvironments,
  listProjects
} from "../lib/api";
import { getInactiveDefaultEnvironment, listActiveEnvironments } from "../lib/environments-view";
import { PageTitle } from "../components/layout/page-title";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

const PROJECT_DEFAULT_ENVIRONMENT = "__project_default__";

export function ProjectGitHubPrDetailPage() {
  const params = useParams<{ projectId: string; prNumber: string }>();
  const navigate = useNavigate();
  const projectId = params.projectId ?? "";
  const prNumber = Number.parseInt(params.prNumber ?? "", 10);
  const [attractorDefId, setAttractorDefId] = useState("");
  const [sourceBranch, setSourceBranch] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [environmentSelection, setEnvironmentSelection] = useState(PROJECT_DEFAULT_ENVIRONMENT);

  const pullQuery = useQuery({
    queryKey: ["github-pull", projectId, prNumber],
    queryFn: () => getProjectGitHubPull(projectId, prNumber),
    enabled: projectId.length > 0 && Number.isInteger(prNumber) && prNumber > 0
  });
  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: listEnvironments
  });
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects
  });

  useEffect(() => {
    if (!pullQuery.data) {
      return;
    }
    if (!attractorDefId && pullQuery.data.launchDefaults.attractorOptions.length > 0) {
      setAttractorDefId(pullQuery.data.launchDefaults.attractorOptions[0]?.id ?? "");
    }
    if (!sourceBranch) {
      setSourceBranch(pullQuery.data.launchDefaults.sourceBranch);
    }
    if (!targetBranch) {
      setTargetBranch(pullQuery.data.launchDefaults.targetBranch);
    }
  }, [attractorDefId, pullQuery.data, sourceBranch, targetBranch]);

  const launchMutation = useMutation({
    mutationFn: () =>
      launchPullRequestReviewRun(projectId, prNumber, {
        attractorDefId,
        ...(environmentSelection !== PROJECT_DEFAULT_ENVIRONMENT
          ? { environmentId: environmentSelection }
          : {}),
        sourceBranch,
        targetBranch
      }),
    onSuccess: (payload) => {
      toast.success(`Review run queued: ${payload.runId}`);
      navigate(`/runs/${payload.runId}?tab=review`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const selectedAttractor = useMemo(
    () => pullQuery.data?.launchDefaults.attractorOptions.find((item) => item.id === attractorDefId) ?? null,
    [attractorDefId, pullQuery.data?.launchDefaults.attractorOptions]
  );
  const activeEnvironments = useMemo(
    () => listActiveEnvironments(environmentsQuery.data ?? []),
    [environmentsQuery.data]
  );
  const project = useMemo(
    () => (projectsQuery.data ?? []).find((candidate) => candidate.id === projectId),
    [projectId, projectsQuery.data]
  );
  const inactiveDefaultEnvironment = useMemo(
    () => getInactiveDefaultEnvironment(project, environmentsQuery.data ?? []),
    [environmentsQuery.data, project]
  );

  if (!pullQuery.data) {
    return <p className="text-sm text-muted-foreground">Loading pull request...</p>;
  }

  const row = pullQuery.data.pull;
  const pull = row.pullRequest;

  return (
    <div>
      <PageTitle
        title={`PR #${pull.prNumber}`}
        description={pull.title}
        actions={
          <Button asChild variant="outline">
            <a href={pull.url} target="_blank" rel="noreferrer">Open in GitHub</a>
          </Button>
        }
      />

      {inactiveDefaultEnvironment ? (
        <Card className="mb-4 border-destructive/60">
          <CardHeader>
            <CardTitle className="text-destructive">Project default environment is inactive</CardTitle>
            <CardDescription>
              Default <span className="mono">{inactiveDefaultEnvironment.name}</span> is inactive. Select an active environment for this run.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[2fr,1fr]">
        <Card>
          <CardHeader>
            <CardTitle>PR Review Context</CardTitle>
            <CardDescription>
              Launch a review attractor to generate fresh artifacts for this PR.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={row.risk === "high" ? "destructive" : row.risk === "medium" ? "warning" : "secondary"}>
                {row.risk}
              </Badge>
              <Badge variant={row.reviewStatus === "Completed" ? "success" : row.reviewStatus === "Overdue" ? "destructive" : row.reviewStatus === "Stale" ? "warning" : "secondary"}>
                {row.reviewStatus}
              </Badge>
              <Badge variant="outline">Head SHA {pull.headSha.slice(0, 12)}</Badge>
              <Badge variant="outline">Due {new Date(row.dueAt).toLocaleString()}</Badge>
            </div>
            {row.staleReason ? (
              <p className="rounded-md border border-border bg-muted/30 p-3">
                {row.staleReason}
              </p>
            ) : null}
            <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3">
              {pull.body?.trim() || "No PR body provided."}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Run Review Attractor</CardTitle>
            <CardDescription>Review council to review summary flow only.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!attractorDefId) {
                  toast.error("Attractor is required");
                  return;
                }
                if (!selectedAttractor?.modelConfig?.provider || !selectedAttractor?.modelConfig?.modelId) {
                  toast.error("Selected attractor is missing model configuration");
                  return;
                }
                launchMutation.mutate();
              }}
            >
              <div className="space-y-1">
                <Label>Attractor</Label>
                <Select value={attractorDefId || undefined} onValueChange={setAttractorDefId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select review attractor" />
                  </SelectTrigger>
                  <SelectContent>
                    {pullQuery.data.launchDefaults.attractorOptions.map((attractor) => (
                      <SelectItem key={attractor.id} value={attractor.id}>
                        {attractor.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {pullQuery.data.launchDefaults.attractorOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No active task attractors are available for this project.
                  </p>
                ) : null}
              </div>

              <div className="space-y-1">
                <Label>Environment</Label>
                <Select value={environmentSelection} onValueChange={setEnvironmentSelection}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={PROJECT_DEFAULT_ENVIRONMENT}>Project default</SelectItem>
                    {activeEnvironments.map((environment) => (
                      <SelectItem key={environment.id} value={environment.id}>
                        {environment.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label>Model (from Attractor)</Label>
                <Input
                  value={
                    selectedAttractor?.modelConfig
                      ? `${selectedAttractor.modelConfig.provider} / ${selectedAttractor.modelConfig.modelId}`
                      : ""
                  }
                  placeholder="Select an attractor with model config"
                  disabled
                />
              </div>

              <div className="space-y-1">
                <Label>Source Branch</Label>
                <Input value={sourceBranch} onChange={(event) => setSourceBranch(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Target Branch</Label>
                <Input value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)} />
              </div>

              <Button
                type="submit"
                disabled={launchMutation.isPending || pullQuery.data.launchDefaults.attractorOptions.length === 0}
              >
                {launchMutation.isPending
                  ? "Queueing..."
                  : row.stale
                    ? "Re-run Review Attractor"
                    : "Run Review Attractor"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {row.openPackPath ? (
              <Button asChild className="w-full">
                <Link to={row.openPackPath}>{row.stale ? "Open Stale Pack" : "Open Linked Run Pack"}</Link>
              </Button>
            ) : null}
            <Button asChild variant="outline" className="w-full">
              <a href={pull.url} target="_blank" rel="noreferrer">Review in GitHub</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
