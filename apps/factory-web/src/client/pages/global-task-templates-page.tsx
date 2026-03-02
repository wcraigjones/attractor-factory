import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { createGlobalTaskTemplate, listGlobalAttractors, listGlobalTaskTemplates } from "../lib/api";
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

function ruleCompatibilityError(rule: TaskTemplateTriggerRule): string | null {
  const issueEvents = new Set([
    "GITHUB_ISSUE_OPENED",
    "GITHUB_ISSUE_REOPENED",
    "GITHUB_ISSUE_LABELED",
    "GITHUB_ISSUE_COMMENT_CREATED"
  ]);
  const prEvents = new Set([
    "GITHUB_PR_OPENED",
    "GITHUB_PR_SYNCHRONIZE",
    "GITHUB_PR_MERGED",
    "GITHUB_PR_REVIEW_CHANGES_REQUESTED",
    "GITHUB_PR_REVIEW_COMMENT_CREATED"
  ]);
  const commentEvents = new Set([
    "GITHUB_ISSUE_COMMENT_CREATED",
    "GITHUB_PR_REVIEW_CHANGES_REQUESTED",
    "GITHUB_PR_REVIEW_COMMENT_CREATED"
  ]);

  if (rule.branchStrategy === "ISSUE_BRANCH" && !issueEvents.has(rule.event)) {
    return "ISSUE_BRANCH can only be used with issue events.";
  }
  if (rule.branchStrategy === "PR_HEAD" && !prEvents.has(rule.event)) {
    return "PR_HEAD can only be used with pull request events.";
  }
  if (rule.labelAny && rule.labelAny.length > 0 && !issueEvents.has(rule.event)) {
    return "labelAny can only be used with issue events.";
  }
  if (rule.commentContainsAny && rule.commentContainsAny.length > 0 && !commentEvents.has(rule.event)) {
    return "commentContainsAny can only be used with comment/review events.";
  }
  if (rule.baseBranchAny && rule.baseBranchAny.length > 0 && !prEvents.has(rule.event)) {
    return "baseBranchAny can only be used with pull request events.";
  }
  if (rule.headBranchAny && rule.headBranchAny.length > 0 && !prEvents.has(rule.event)) {
    return "headBranchAny can only be used with pull request events.";
  }

  return null;
}

export function GlobalTaskTemplatesPage() {
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

  const templatesQuery = useQuery({ queryKey: ["global-task-templates"], queryFn: listGlobalTaskTemplates });
  const attractorsQuery = useQuery({ queryKey: ["global-attractors"], queryFn: listGlobalAttractors });

  const attractorNames = useMemo(
    () => (attractorsQuery.data ?? []).filter((item) => item.active).map((item) => item.name),
    [attractorsQuery.data]
  );

  const createMutation = useMutation({
    mutationFn: () =>
      createGlobalTaskTemplate({
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
      toast.success("Global task template saved");
      setName("");
      setDescription("");
      setRules([defaultRule()]);
      void queryClient.invalidateQueries({ queryKey: ["global-task-templates"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  return (
    <div>
      <PageTitle
        title="Global Task Templates"
        description="Reusable run templates that propagate to all projects."
      />

      <div className="grid gap-4 lg:grid-cols-[2fr,1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Templates</CardTitle>
            <CardDescription>Project templates with the same name override inherited global templates.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Attractor</TableHead>
                  <TableHead>Run Type</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Triggers</TableHead>
                  <TableHead>Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(templatesQuery.data ?? []).map((template) => (
                  <TableRow key={template.id}>
                    <TableCell>{template.name}</TableCell>
                    <TableCell>{template.attractorName}</TableCell>
                    <TableCell>{template.runType}</TableCell>
                    <TableCell>
                      {template.scheduleEnabled
                        ? `${template.scheduleCron ?? ""} (${template.scheduleTimezone ?? "UTC"})`
                        : "disabled"}
                    </TableCell>
                    <TableCell>{Array.isArray(template.triggersJson) ? template.triggersJson.length : 0}</TableCell>
                    <TableCell>
                      <Badge variant={template.active ? "success" : "secondary"}>
                        {template.active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Create Template</CardTitle>
            <CardDescription>Create or update by name.</CardDescription>
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
                const ruleError = rules.map((rule) => ruleCompatibilityError(rule)).find(Boolean);
                if (ruleError) {
                  toast.error(ruleError);
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
                    {attractorNames.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
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
              <div className="space-y-1">
                <Label>Source Branch</Label>
                <Input value={sourceBranch} onChange={(event) => setSourceBranch(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Target Branch</Label>
                <Input value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)} />
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
                <div className="space-y-1">
                  <Label>Environment Name</Label>
                  <Input value={environmentName} onChange={(event) => setEnvironmentName(event.target.value)} />
                </div>
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
                <>
                  <div className="space-y-1">
                    <Label>Cron</Label>
                    <Input value={scheduleCron} onChange={(event) => setScheduleCron(event.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>Timezone</Label>
                    <Input value={scheduleTimezone} onChange={(event) => setScheduleTimezone(event.target.value)} />
                  </div>
                </>
              ) : null}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Trigger Rules</Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setRules((prev) => [...prev, defaultRule()])}
                  >
                    Add Rule
                  </Button>
                </div>
                {rules.map((rule, index) => {
                  const compatibilityError = ruleCompatibilityError(rule);
                  return (
                    <Card key={rule.id}>
                      <CardContent className="space-y-2 pt-4">
                        <div className="grid gap-2 md:grid-cols-2">
                          <div className="space-y-1">
                            <Label>Event</Label>
                            <Select
                              value={rule.event}
                              onValueChange={(value: TaskTemplateTriggerEvent) => {
                                setRules((prev) =>
                                  prev.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, event: value } : item
                                  )
                                );
                              }}
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
                          </div>
                          <div className="space-y-1">
                            <Label>Branch Strategy</Label>
                            <Select
                              value={rule.branchStrategy}
                              onValueChange={(value: TaskTemplateBranchStrategy) => {
                                setRules((prev) =>
                                  prev.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, branchStrategy: value } : item
                                  )
                                );
                              }}
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
                          </div>
                        </div>
                        <div className="grid gap-2 md:grid-cols-2">
                          <Input
                            placeholder="labelAny (csv)"
                            value={joinCsv(rule.labelAny)}
                            onChange={(event) => {
                              const labelAny = splitCsv(event.target.value);
                              setRules((prev) =>
                                prev.map((item, itemIndex) =>
                                  itemIndex === index ? { ...item, labelAny } : item
                                )
                              );
                            }}
                          />
                          <Input
                            placeholder="commentContainsAny (csv)"
                            value={joinCsv(rule.commentContainsAny)}
                            onChange={(event) => {
                              const commentContainsAny = splitCsv(event.target.value);
                              setRules((prev) =>
                                prev.map((item, itemIndex) =>
                                  itemIndex === index ? { ...item, commentContainsAny } : item
                                )
                              );
                            }}
                          />
                          <Input
                            placeholder="baseBranchAny (csv)"
                            value={joinCsv(rule.baseBranchAny)}
                            onChange={(event) => {
                              const baseBranchAny = splitCsv(event.target.value);
                              setRules((prev) =>
                                prev.map((item, itemIndex) =>
                                  itemIndex === index ? { ...item, baseBranchAny } : item
                                )
                              );
                            }}
                          />
                          <Input
                            placeholder="headBranchAny (csv)"
                            value={joinCsv(rule.headBranchAny)}
                            onChange={(event) => {
                              const headBranchAny = splitCsv(event.target.value);
                              setRules((prev) =>
                                prev.map((item, itemIndex) =>
                                  itemIndex === index ? { ...item, headBranchAny } : item
                                )
                              );
                            }}
                          />
                        </div>
                        {compatibilityError ? <p className="text-xs text-destructive">{compatibilityError}</p> : null}
                        <div className="flex justify-end">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setRules((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
                            }}
                            disabled={rules.length === 1}
                          >
                            Remove
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
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
    </div>
  );
}
