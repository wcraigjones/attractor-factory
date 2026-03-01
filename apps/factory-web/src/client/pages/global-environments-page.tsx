import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  createEnvironment,
  listEnvironments,
  updateEnvironment
} from "../lib/api";
import type { Environment, EnvironmentResources } from "../lib/types";
import { PageTitle } from "../components/layout/page-title";
import { EnvironmentShellDialog } from "../components/environment-shell-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";

const DIGEST_PIN_PATTERN = /@sha256:[a-f0-9]{64}$/i;
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

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
  return name.length > 0 && IMAGE_TAG_PATTERN.test(tag);
}

function isValidRunnerImageReference(value: string): boolean {
  return DIGEST_PIN_PATTERN.test(value) || isTaggedImage(value);
}

interface EnvironmentFormState {
  name: string;
  runnerImage: string;
  setupScript: string;
  serviceAccountName: string;
  requestCpu: string;
  requestMemory: string;
  limitCpu: string;
  limitMemory: string;
  active: boolean;
}

function emptyEnvironmentForm(): EnvironmentFormState {
  return {
    name: "",
    runnerImage: "",
    setupScript: "",
    serviceAccountName: "",
    requestCpu: "",
    requestMemory: "",
    limitCpu: "",
    limitMemory: "",
    active: true
  };
}

function toEnvironmentResources(form: EnvironmentFormState): EnvironmentResources | undefined {
  const requests = {
    ...(form.requestCpu.trim().length > 0 ? { cpu: form.requestCpu.trim() } : {}),
    ...(form.requestMemory.trim().length > 0 ? { memory: form.requestMemory.trim() } : {})
  };
  const limits = {
    ...(form.limitCpu.trim().length > 0 ? { cpu: form.limitCpu.trim() } : {}),
    ...(form.limitMemory.trim().length > 0 ? { memory: form.limitMemory.trim() } : {})
  };
  if (Object.keys(requests).length === 0 && Object.keys(limits).length === 0) {
    return undefined;
  }
  return {
    ...(Object.keys(requests).length > 0 ? { requests } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {})
  };
}

function toFormState(environment: Environment): EnvironmentFormState {
  return {
    name: environment.name,
    runnerImage: environment.runnerImage,
    setupScript: environment.setupScript ?? "",
    serviceAccountName: environment.serviceAccountName ?? "",
    requestCpu: environment.resourcesJson?.requests?.cpu ?? "",
    requestMemory: environment.resourcesJson?.requests?.memory ?? "",
    limitCpu: environment.resourcesJson?.limits?.cpu ?? "",
    limitMemory: environment.resourcesJson?.limits?.memory ?? "",
    active: environment.active
  };
}

export function GlobalEnvironmentsPage() {
  const queryClient = useQueryClient();
  const [editingEnvironmentId, setEditingEnvironmentId] = useState<string | null>(null);
  const [form, setForm] = useState<EnvironmentFormState>(emptyEnvironmentForm());
  const [shellEnvironment, setShellEnvironment] = useState<Environment | null>(null);
  const [shellOpen, setShellOpen] = useState(false);

  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: listEnvironments
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const name = form.name.trim();
      if (name.length < 2 || name.length > 80) {
        throw new Error("Environment name must be between 2 and 80 characters");
      }
      const runnerImage = form.runnerImage.trim();
      if (!isValidRunnerImageReference(runnerImage)) {
        throw new Error(
          "Runner image must include a tag or digest (examples: ghcr.io/org/image:latest or ghcr.io/org/image@sha256:...)"
        );
      }
      const resources = toEnvironmentResources(form);
      if (editingEnvironmentId) {
        return updateEnvironment(editingEnvironmentId, {
          name,
          runnerImage,
          setupScript: form.setupScript.length > 0 ? form.setupScript : null,
          serviceAccountName: form.serviceAccountName.trim().length > 0 ? form.serviceAccountName.trim() : null,
          ...(resources ? { resourcesJson: resources } : { resourcesJson: null }),
          active: form.active
        });
      }
      return createEnvironment({
        name,
        kind: "KUBERNETES_JOB",
        runnerImage,
        ...(form.setupScript.length > 0 ? { setupScript: form.setupScript } : {}),
        ...(form.serviceAccountName.trim().length > 0 ? { serviceAccountName: form.serviceAccountName.trim() } : {}),
        ...(resources ? { resourcesJson: resources } : {}),
        active: form.active
      });
    },
    onSuccess: () => {
      toast.success(editingEnvironmentId ? "Environment updated" : "Environment created");
      setEditingEnvironmentId(null);
      setForm(emptyEnvironmentForm());
      void queryClient.invalidateQueries({ queryKey: ["environments"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const toggleMutation = useMutation({
    mutationFn: async (environment: Environment) =>
      updateEnvironment(environment.id, {
        active: !environment.active
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["environments"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const sortedEnvironments = useMemo(
    () =>
      [...(environmentsQuery.data ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name)
      ),
    [environmentsQuery.data]
  );

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4">
      <PageTitle
        title="Global Environments"
        description="Define and customize reusable runtime environments."
      />

      <div className="grid gap-4 lg:grid-cols-[1fr,2fr]">
        <Card>
          <CardHeader>
            <CardTitle>{editingEnvironmentId ? "Edit Environment" : "Create Environment"}</CardTitle>
            <CardDescription>
              Configure runner image, service account, resources, and status.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                saveMutation.mutate();
              }}
            >
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>Runner Image (tag or digest)</Label>
                <Input
                  value={form.runnerImage}
                  onChange={(event) => setForm((prev) => ({ ...prev, runnerImage: event.target.value }))}
                  placeholder="ghcr.io/org/image:latest"
                />
              </div>
              <div className="space-y-1">
                <Label>Service Account (optional)</Label>
                <Input
                  value={form.serviceAccountName}
                  onChange={(event) => setForm((prev) => ({ ...prev, serviceAccountName: event.target.value }))}
                  placeholder="factory-runner"
                />
              </div>
              <div className="space-y-1">
                <Label>Setup Script (optional, runs at run startup)</Label>
                <Textarea
                  value={form.setupScript}
                  onChange={(event) => setForm((prev) => ({ ...prev, setupScript: event.target.value }))}
                  placeholder={"npm ci\nnpm run prisma:generate"}
                  rows={6}
                />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <Label>Request CPU</Label>
                  <Input
                    value={form.requestCpu}
                    onChange={(event) => setForm((prev) => ({ ...prev, requestCpu: event.target.value }))}
                    placeholder="500m"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Request Memory</Label>
                  <Input
                    value={form.requestMemory}
                    onChange={(event) => setForm((prev) => ({ ...prev, requestMemory: event.target.value }))}
                    placeholder="1Gi"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Limit CPU</Label>
                  <Input
                    value={form.limitCpu}
                    onChange={(event) => setForm((prev) => ({ ...prev, limitCpu: event.target.value }))}
                    placeholder="2"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Limit Memory</Label>
                  <Input
                    value={form.limitMemory}
                    onChange={(event) => setForm((prev) => ({ ...prev, limitMemory: event.target.value }))}
                    placeholder="4Gi"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Status</Label>
                <Select
                  value={form.active ? "active" : "inactive"}
                  onValueChange={(value) => setForm((prev) => ({ ...prev, active: value === "active" }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">active</SelectItem>
                    <SelectItem value="inactive">inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? "Saving..." : editingEnvironmentId ? "Save Changes" : "Create Environment"}
                </Button>
                {editingEnvironmentId ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditingEnvironmentId(null);
                      setForm(emptyEnvironmentForm());
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Environment Definitions</CardTitle>
            <CardDescription>Manage active/inactive environments and launch test shells.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Runner Image</TableHead>
                    <TableHead>Setup</TableHead>
                    <TableHead>Service Account</TableHead>
                    <TableHead>Resources</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedEnvironments.map((environment) => (
                    <TableRow key={environment.id}>
                      <TableCell>{environment.name}</TableCell>
                      <TableCell>{environment.kind}</TableCell>
                      <TableCell className="mono text-xs">{environment.runnerImage}</TableCell>
                      <TableCell>{environment.setupScript ? "configured" : "-"}</TableCell>
                      <TableCell>{environment.serviceAccountName ?? "-"}</TableCell>
                      <TableCell className="mono text-xs">
                        req(cpu={environment.resourcesJson?.requests?.cpu ?? "-"},mem={environment.resourcesJson?.requests?.memory ?? "-"}){" "}
                        lim(cpu={environment.resourcesJson?.limits?.cpu ?? "-"},mem={environment.resourcesJson?.limits?.memory ?? "-"})
                      </TableCell>
                      <TableCell>
                        <Badge variant={environment.active ? "success" : "secondary"}>
                          {environment.active ? "active" : "inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell>{new Date(environment.updatedAt).toLocaleString()}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditingEnvironmentId(environment.id);
                              setForm(toFormState(environment));
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => toggleMutation.mutate(environment)}
                            disabled={toggleMutation.isPending}
                          >
                            {environment.active ? "Deactivate" : "Activate"}
                          </Button>
                          {environment.active ? (
                            <Button
                              size="sm"
                              onClick={() => {
                                setShellEnvironment(environment);
                                setShellOpen(true);
                              }}
                            >
                              Open Shell
                            </Button>
                          ) : null}
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
        onClose={() => {
          setShellOpen(false);
          setShellEnvironment(null);
        }}
      />
    </div>
  );
}
