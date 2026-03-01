import { Link, useParams } from "react-router-dom";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { listEnvironments, listProjects, setProjectDefaultEnvironment } from "../lib/api";
import { getInactiveDefaultEnvironment, listActiveEnvironments } from "../lib/environments-view";
import type { Environment } from "../lib/types";
import { PageTitle } from "../components/layout/page-title";
import { EnvironmentShellDialog } from "../components/environment-shell-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

export function ProjectEnvironmentsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId ?? "";
  const queryClient = useQueryClient();
  const [shellOpen, setShellOpen] = useState(false);
  const [shellEnvironment, setShellEnvironment] = useState<Environment | null>(null);

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects
  });
  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: listEnvironments
  });

  const project = useMemo(
    () => (projectsQuery.data ?? []).find((candidate) => candidate.id === projectId),
    [projectId, projectsQuery.data]
  );
  const activeEnvironments = useMemo(
    () => listActiveEnvironments(environmentsQuery.data ?? []),
    [environmentsQuery.data]
  );
  const defaultEnvironment = useMemo(
    () => activeEnvironments.find((environment) => environment.id === project?.defaultEnvironmentId) ?? null,
    [activeEnvironments, project?.defaultEnvironmentId]
  );
  const inactiveDefault = useMemo(
    () => getInactiveDefaultEnvironment(project, environmentsQuery.data ?? []),
    [environmentsQuery.data, project]
  );

  const setDefaultMutation = useMutation({
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

  if (!project) {
    return <p className="text-sm text-muted-foreground">Project not found.</p>;
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4">
      <PageTitle
        title="Project Environments"
        description={`Manage environment usage for ${project.name}`}
        actions={
          <Button asChild variant="outline">
            <Link to={`/projects/${project.id}/runs`}>Back To Runs</Link>
          </Button>
        }
      />

      {inactiveDefault ? (
        <Card className="mb-4 border-destructive/60">
          <CardHeader>
            <CardTitle className="text-destructive">Inactive default environment</CardTitle>
            <CardDescription>
              Project default environment <span className="mono">{inactiveDefault.name}</span> is inactive. Select an active environment.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr,2fr]">
        <Card>
          <CardHeader>
            <CardTitle>Current Default</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">Environment:</span> {defaultEnvironment?.name ?? "-"}
            </p>
            <p>
              <span className="text-muted-foreground">Kind:</span> {defaultEnvironment?.kind ?? "-"}
            </p>
            <p>
              <span className="text-muted-foreground">Runner:</span>{" "}
              <span className="mono text-xs">{defaultEnvironment?.runnerImage ?? "-"}</span>
            </p>
            <p>
              <span className="text-muted-foreground">Setup Script:</span>{" "}
              {defaultEnvironment?.setupScript ? "configured" : "-"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Active Environments</CardTitle>
            <CardDescription>Only active environments can be selected as project defaults and run targets.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Runner Image</TableHead>
                    <TableHead>Setup</TableHead>
                    <TableHead>Service Account</TableHead>
                    <TableHead>Resources</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeEnvironments.map((environment) => (
                    <TableRow key={environment.id}>
                      <TableCell>{environment.name}</TableCell>
                      <TableCell className="mono text-xs">{environment.runnerImage}</TableCell>
                      <TableCell>{environment.setupScript ? "configured" : "-"}</TableCell>
                      <TableCell>{environment.serviceAccountName ?? "-"}</TableCell>
                      <TableCell className="mono text-xs">
                        req(cpu={environment.resourcesJson?.requests?.cpu ?? "-"},mem={environment.resourcesJson?.requests?.memory ?? "-"}){" "}
                        lim(cpu={environment.resourcesJson?.limits?.cpu ?? "-"},mem={environment.resourcesJson?.limits?.memory ?? "-"})
                      </TableCell>
                      <TableCell>
                        <Badge variant={environment.id === project.defaultEnvironmentId ? "success" : "secondary"}>
                          {environment.id === project.defaultEnvironmentId ? "default" : "active"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setDefaultMutation.mutate(environment.id)}
                            disabled={setDefaultMutation.isPending || environment.id === project.defaultEnvironmentId}
                          >
                            Use As Default
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => {
                              setShellEnvironment(environment);
                              setShellOpen(true);
                            }}
                          >
                            Open Shell
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <EnvironmentShellDialog
        open={shellOpen}
        environment={shellEnvironment}
        defaultProjectId={project.id}
        onClose={() => {
          setShellOpen(false);
          setShellEnvironment(null);
        }}
      />
    </div>
  );
}
