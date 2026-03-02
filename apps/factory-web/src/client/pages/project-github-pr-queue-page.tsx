import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "../components/ui/toast";

import { listProjectGitHubPulls, reconcileProjectGitHub } from "../lib/api";
import { PageTitle } from "../components/layout/page-title";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

function riskVariant(risk: "low" | "medium" | "high"): "secondary" | "warning" | "destructive" {
  if (risk === "high") {
    return "destructive";
  }
  if (risk === "medium") {
    return "warning";
  }
  return "secondary";
}

function statusVariant(status: "Pending" | "Completed" | "Overdue" | "Stale"): "secondary" | "success" | "destructive" | "warning" {
  if (status === "Completed") {
    return "success";
  }
  if (status === "Stale") {
    return "warning";
  }
  if (status === "Overdue") {
    return "destructive";
  }
  return "secondary";
}

export function ProjectGitHubPrQueuePage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId ?? "";
  const queryClient = useQueryClient();
  const pullsQuery = useQuery({
    queryKey: ["github-pulls", projectId],
    queryFn: () => listProjectGitHubPulls(projectId, { state: "open", limit: 200 }),
    enabled: projectId.length > 0
  });

  const reconcileMutation = useMutation({
    mutationFn: () => reconcileProjectGitHub(projectId),
    onSuccess: () => {
      toast.success("GitHub sync complete");
      void queryClient.invalidateQueries({ queryKey: ["github-pulls", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["github-issues", projectId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  return (
    <div>
      <PageTitle
        title="PR Review Queue"
        description="SLA-prioritized queue for review packs generated from synchronized pull requests."
        actions={
          <Button onClick={() => reconcileMutation.mutate()} disabled={reconcileMutation.isPending}>
            {reconcileMutation.isPending ? "Syncing..." : "Sync Now"}
          </Button>
        }
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Compliance Rule</CardTitle>
          <CardDescription>
            Any non-empty reviewer feedback is treated as a non-approval outcome (request changes unless explicitly reject).
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pull Requests</CardTitle>
          <CardDescription>Open PRs sorted by open time with linked review-run state and stale detection.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PR</TableHead>
                <TableHead>Risk</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Critical</TableHead>
                <TableHead>Artifacts</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(pullsQuery.data ?? []).map((row) => (
                <TableRow key={row.pullRequest.id}>
                  <TableCell>
                    <div className="space-y-1">
                      <p className="mono text-xs">#{row.pullRequest.prNumber}</p>
                      <p>{row.pullRequest.title}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={riskVariant(row.risk)}>{row.risk}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(row.reviewStatus)}>{row.reviewStatus}</Badge>
                  </TableCell>
                  <TableCell>{row.criticalCount}</TableCell>
                  <TableCell>{row.artifactCount}</TableCell>
                  <TableCell>
                    <div className="text-xs">
                      <p>{new Date(row.dueAt).toLocaleString()}</p>
                      <p className="text-muted-foreground">
                        {row.minutesRemaining < 0
                          ? `${Math.abs(row.minutesRemaining)} min overdue`
                          : `${row.minutesRemaining} min remaining`}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell>
                    {row.openPackPath && !row.stale ? (
                      <Button asChild size="sm" variant="outline">
                        <Link to={row.openPackPath}>Open Pack</Link>
                      </Button>
                    ) : (
                      <Button asChild size="sm" variant="outline">
                        <Link to={`/projects/${projectId}/github/pulls/${row.pullRequest.prNumber}`}>
                          {row.stale ? "Re-run Review" : "Run Review"}
                        </Link>
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {(pullsQuery.data?.length ?? 0) === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No synchronized pull requests yet.</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
