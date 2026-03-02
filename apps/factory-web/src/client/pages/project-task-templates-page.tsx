import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  createProjectTaskTemplate,
  launchProjectTaskTemplateRun,
  listAttractors,
  listProjectTaskTemplateEvents,
  listProjectTaskTemplates,
  replayProjectTaskTemplateEvent
} from "../lib/api";
import { buildEffectiveAttractors } from "../lib/attractors-view";
import { buildTaskTemplateViewRows } from "../lib/task-templates-view";
import type {
  TaskTemplateBranchStrategy,
  TaskTemplateTriggerEvent,
  TaskTemplateTriggerRule
} from "../lib/types";
import { PageTitle } from "../components/layout/page-title";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";

const EVENT_OPTIONS: Array<{ value: TaskTemplateTriggerEvent; label: string }> = [
  { value: "GITHUB_ISSUE_OPENED", label: "Issue Opened" },
  { value: "GITHUB_ISSUE_REOPENED", label: "Issue Reopened" },
  { value: "GITHUB_ISSUE_LABELED", label: "Issue Labeled" },
  { value: "GITHUB_ISSUE_COMMENT_CREATED", label: "Issue Comment Created" },
  { value: "GITHUB_PR_OPENED", label: "PR Opened" },
  { value: "GITHUB_PR_SYNCHRONIZE", label: "PR Synchronize" },
  { value: "GITHUB_PR_MERGED", label: "PR Merged" },
  { value: "GITHUB_PR_REVIEW_CHANGES_REQUESTED", label: "PR Review Changes Requested" },
  { value: "GITHUB_PR_REVIEW_COMMENT_CREATED", label: "PR Review Comment Created" }
];

const BRANCH_STRATEGY_OPTIONS: Array<{ value: TaskTemplateBranchStrategy; label: string }> = [
  { value: "TEMPLATE_DEFAULT", label: "Template Default" },
  { value: "ISSUE_BRANCH", label: "Issue Branch" },
  { value: "PR_HEAD", label: "PR Head" }
];

function splitCsv(value: string): string[] | undefined {
  const normalized = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function joinCsv(values: string[] | undefined): string {
  return values?.join(", ") ?? "";
}

function nextRuleId() {
  return `rule-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultRule(): TaskTemplateTriggerRule {
  return {
    id: nextRuleId(),
    enabled: true,
    event: "GITHUB_ISSUE_OPENED",
    branchStrategy: "ISSUE_BRANCH"
  };
}

export function ProjectTaskTemplatesPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId ?? "";
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [attractorName, setAttractorName] = useState("");
  const [runType, setRunType] = useState<"planning" | "implementation" | "task">("task");
  const [sourceBranch, setSourceBranch] = useState("main");
  const [targetBranch, setTargetBranch] = useState("main");
  const [environmentMode, setEnvironmentMode] = useState<"PROJECT_DEFAULT" | "NAMED">("PROJECT_DEFAULT");
  const [environmentName, setEnvironmentName] = useState("");
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleCron, setScheduleCron] = useState("0 9 * * 1-5");
  const [scheduleTimezone, setScheduleTimezone] = useState("UTC");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);
  const [rules, setRules] = useState<TaskTemplateTriggerRule[]>([defaultRule()]);

  const templatesQuery = useQuery({
    queryKey: ["project-task-templates", projectId],
    queryFn: () => listProjectTaskTemplates(projectId),
    enabled: projectId.length > 0
  });
  const eventsQuery = useQuery({
    queryKey: ["project-task-template-events", projectId],
    queryFn: () => listProjectTaskTemplateEvents(projectId),
    enabled: projectId.length > 0
  });
  const attractorsQuery = useQuery({
    queryKey: ["attractors", projectId],
    queryFn: () => listAttractors(projectId),
    enabled: projectId.length > 0
  });

  const effectiveAttractors = useMemo(
    () => buildEffectiveAttractors(attractorsQuery.data ?? []).filter((item) => item.active),
    [attractorsQuery.data]
  );
  const rows = useMemo(
    () => buildTaskTemplateViewRows(templatesQuery.data ?? []),
    [templatesQuery.data]
  );

  const createMutation = useMutation({
    mutationFn: () =>
      createProjectTaskTemplate(projectId, {
        name: name.trim(),
        attractorName: attractorName.trim(),
        runType,
        sourceBranch: sourceBranch.trim(),
        targetBranch: targetBranch.trim(),
        environmentMode,
        environmentName: environmentMode === "NAMED" ? environmentName.trim() : null,
        scheduleEnabled,
        scheduleCron: scheduleEnabled ? scheduleCron.trim() : null,
        scheduleTimezone: scheduleEnabled ? scheduleTimezone.trim() : null,
        triggers: rules,
        description: description.trim() || null,
        active
      }),
    onSuccess: () => {
      toast.success("Task template saved");
      setName("");
      setDescription("");
      setRules([defaultRule()]);
      void queryClient.invalidateQueries({ queryKey: ["project-task-templates", projectId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const runMutation = useMutation({
    mutationFn: (templateId: string) => launchProjectTaskTemplateRun(projectId, templateId),
    onSuccess: (payload) => {
      toast.success(`Run queued: ${payload.runId}`);
      void queryClient.invalidateQueries({ queryKey: ["project-runs", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["project-task-template-events", projectId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const replayMutation = useMutation({
    mutationFn: (eventId: string) => replayProjectTaskTemplateEvent(projectId, eventId),
    onSuccess: (payload) => {
      toast.success(`Replay queued: ${payload.runId}`);
      void queryClient.invalidateQueries({ queryKey: ["project-runs", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["project-task-template-events", projectId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  return (
    <div>
      <PageTitle
        title="Task Templates"
        description="On-demand, scheduled, and event-triggered template launches."
        actions={
          <Button asChild variant="outline">
            <Link to={`/projects/${projectId}/runs`}>View Runs</Link>
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[2fr,1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Templates</CardTitle>
            <CardDescription>Project templates override inherited globals by name.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Attractor</TableHead>
                  <TableHead>Run Type</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} className={row.muted ? "bg-muted/20 text-muted-foreground" : undefined}>
                    <TableCell>
                      <Badge variant={row.source === "project" ? "default" : "outline"}>
                        {row.source === "project" ? "Project" : "Global"}
                      </Badge>
                    </TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell>{row.attractorName}</TableCell>
                    <TableCell>{row.runType}</TableCell>
                    <TableCell>
                      {row.scheduleEnabled
                        ? `${row.scheduleNextRunAt ? `next ${new Date(row.scheduleNextRunAt).toLocaleString()}` : "scheduled"}`
                        : "disabled"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge variant={row.active ? "success" : "secondary"}>
                          {row.active ? "Active" : "Inactive"}
                        </Badge>
                        <Badge variant={row.status === "Overridden" ? "warning" : row.status === "Project" ? "default" : "success"}>
                          {row.status}
                        </Badge>
                        {row.scheduleLastError ? (
                          <span className="text-xs text-destructive">{row.scheduleLastError}</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => runMutation.mutate(row.taskTemplateId)}
                        disabled={!row.active || row.status === "Overridden" || runMutation.isPending}
                      >
                        Run Now
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Create Project Template</CardTitle>
            <CardDescription>Uses structured trigger rules.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim() || !attractorName.trim()) {
                  toast.error("Name and attractor are required");
                  return;
                }
                createMutation.mutate();
              }}
            >
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Attractor</Label>
                <Select value={attractorName || undefined} onValueChange={setAttractorName}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select attractor" />
                  </SelectTrigger>
                  <SelectContent>
                    {effectiveAttractors.map((item) => (
                      <SelectItem key={item.id} value={item.name}>
                        {item.scope === "PROJECT" ? item.name : `${item.name} (global)`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Run Type</Label>
                <Select value={runType} onValueChange={(value: "planning" | "implementation" | "task") => setRunType(value)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="planning">planning</SelectItem>
                    <SelectItem value="implementation">implementation</SelectItem>
                    <SelectItem value="task">task</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <Input placeholder="source branch" value={sourceBranch} onChange={(event) => setSourceBranch(event.target.value)} />
                <Input placeholder="target branch" value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Environment Mode</Label>
                <Select value={environmentMode} onValueChange={(value: "PROJECT_DEFAULT" | "NAMED") => setEnvironmentMode(value)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PROJECT_DEFAULT">PROJECT_DEFAULT</SelectItem>
                    <SelectItem value="NAMED">NAMED</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {environmentMode === "NAMED" ? (
                <Input placeholder="environment name" value={environmentName} onChange={(event) => setEnvironmentName(event.target.value)} />
              ) : null}
              <div className="space-y-1">
                <Label>Schedule Enabled</Label>
                <Select value={scheduleEnabled ? "true" : "false"} onValueChange={(value) => setScheduleEnabled(value === "true")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">true</SelectItem>
                    <SelectItem value="false">false</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {scheduleEnabled ? (
                <div className="grid gap-2 md:grid-cols-2">
                  <Input placeholder="cron" value={scheduleCron} onChange={(event) => setScheduleCron(event.target.value)} />
                  <Input placeholder="timezone" value={scheduleTimezone} onChange={(event) => setScheduleTimezone(event.target.value)} />
                </div>
              ) : null}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Trigger Rules</Label>
                  <Button type="button" size="sm" variant="outline" onClick={() => setRules((prev) => [...prev, defaultRule()])}>
                    Add Rule
                  </Button>
                </div>
                {rules.map((rule, index) => (
                  <Card key={rule.id}>
                    <CardContent className="space-y-2 pt-4">
                      <div className="grid gap-2 md:grid-cols-2">
                        <Select
                          value={rule.event}
                          onValueChange={(value: TaskTemplateTriggerEvent) =>
                            setRules((prev) => prev.map((item, i) => (i === index ? { ...item, event: value } : item)))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {EVENT_OPTIONS.map((event) => (
                              <SelectItem key={event.value} value={event.value}>
                                {event.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={rule.branchStrategy}
                          onValueChange={(value: TaskTemplateBranchStrategy) =>
                            setRules((prev) => prev.map((item, i) => (i === index ? { ...item, branchStrategy: value } : item)))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {BRANCH_STRATEGY_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          placeholder="labelAny (csv)"
                          value={joinCsv(rule.labelAny)}
                          onChange={(event) => {
                            const labelAny = splitCsv(event.target.value);
                            setRules((prev) => prev.map((item, i) => (i === index ? { ...item, labelAny } : item)));
                          }}
                        />
                        <Input
                          placeholder="commentContainsAny (csv)"
                          value={joinCsv(rule.commentContainsAny)}
                          onChange={(event) => {
                            const commentContainsAny = splitCsv(event.target.value);
                            setRules((prev) => prev.map((item, i) => (i === index ? { ...item, commentContainsAny } : item)));
                          }}
                        />
                        <Input
                          placeholder="baseBranchAny (csv)"
                          value={joinCsv(rule.baseBranchAny)}
                          onChange={(event) => {
                            const baseBranchAny = splitCsv(event.target.value);
                            setRules((prev) => prev.map((item, i) => (i === index ? { ...item, baseBranchAny } : item)));
                          }}
                        />
                        <Input
                          placeholder="headBranchAny (csv)"
                          value={joinCsv(rule.headBranchAny)}
                          onChange={(event) => {
                            const headBranchAny = splitCsv(event.target.value);
                            setRules((prev) => prev.map((item, i) => (i === index ? { ...item, headBranchAny } : item)));
                          }}
                        />
                      </div>
                      <div className="flex justify-end">
                        <Button type="button" size="sm" variant="outline" disabled={rules.length === 1} onClick={() => setRules((prev) => prev.filter((_, i) => i !== index))}>
                          Remove
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <div className="space-y-1">
                <Label>Description</Label>
                <Textarea value={description} onChange={(event) => setDescription(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Active</Label>
                <Select value={active ? "true" : "false"} onValueChange={(value) => setActive(value === "true")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">true</SelectItem>
                    <SelectItem value="false">false</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Saving..." : "Save Template"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Event Ledger</CardTitle>
          <CardDescription>Matched and triggered event history with replay support.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(eventsQuery.data ?? []).map((event) => (
                <TableRow key={event.id}>
                  <TableCell>{new Date(event.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{event.taskTemplate?.name ?? event.taskTemplateId}</TableCell>
                  <TableCell>{event.eventName}</TableCell>
                  <TableCell>
                    <Badge variant={event.status === "TRIGGERED" || event.status === "REPLAYED" ? "success" : event.status === "FAILED" ? "destructive" : "secondary"}>
                      {event.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {event.runId ? (
                      <Button asChild size="sm" variant="outline">
                        <Link to={`/runs/${event.runId}`}>Open</Link>
                      </Button>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => replayMutation.mutate(event.id)}
                      disabled={replayMutation.isPending}
                    >
                      Replay
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
