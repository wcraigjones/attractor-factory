import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { toast } from "sonner";

import {
  approveAgentAction,
  archiveAgentSession,
  createAgentSession,
  listAgentSessionMessages,
  listAgentSessions,
  postAgentMessage,
  rejectAgentAction
} from "../lib/api";
import type { AgentAction, AgentSession } from "../lib/types";
import { PageTitle } from "../components/layout/page-title";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";

function actionStatusVariant(status: AgentAction["status"]): "secondary" | "success" | "destructive" | "warning" {
  if (status === "EXECUTED") {
    return "success";
  }
  if (status === "REJECTED") {
    return "warning";
  }
  if (status === "FAILED") {
    return "destructive";
  }
  return "secondary";
}

function scopeDescription(scope: "GLOBAL" | "PROJECT", projectId: string | undefined): string {
  if (scope === "GLOBAL") {
    return "Global assistant session with on-demand factory tools.";
  }
  return `Project assistant for ${projectId ?? "current project"} with action approvals for risky operations.`;
}

function AgentChatPageBase(props: { scope: "GLOBAL" | "PROJECT" }) {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const queryClient = useQueryClient();
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftMessage, setDraftMessage] = useState("");

  const sessionsQuery = useQuery({
    queryKey: ["agent-sessions", props.scope, projectId],
    queryFn: () => listAgentSessions({ scope: props.scope, projectId }),
    enabled: props.scope === "GLOBAL" || Boolean(projectId)
  });

  useEffect(() => {
    const first = sessionsQuery.data?.[0]?.id;
    if (!first) {
      setSelectedSessionId("");
      return;
    }
    setSelectedSessionId((current) => (current.length > 0 ? current : first));
  }, [sessionsQuery.data]);

  const activeSession = useMemo<AgentSession | null>(() => {
    if (!selectedSessionId) {
      return null;
    }
    return sessionsQuery.data?.find((session) => session.id === selectedSessionId) ?? null;
  }, [selectedSessionId, sessionsQuery.data]);

  const messagesQuery = useQuery({
    queryKey: ["agent-session-messages", selectedSessionId],
    queryFn: () => listAgentSessionMessages(selectedSessionId, 400),
    enabled: selectedSessionId.length > 0
  });

  const createSessionMutation = useMutation({
    mutationFn: () =>
      createAgentSession({
        scope: props.scope,
        ...(props.scope === "PROJECT" ? { projectId } : {}),
        ...(draftTitle.trim() ? { title: draftTitle.trim() } : {})
      }),
    onSuccess: (created) => {
      setDraftTitle("");
      setSelectedSessionId(created.id);
      toast.success("Session created");
      void queryClient.invalidateQueries({ queryKey: ["agent-sessions", props.scope, projectId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const archiveSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await archiveAgentSession(sessionId);
      return sessionId;
    },
    onSuccess: () => {
      setSelectedSessionId("");
      toast.success("Session archived");
      void queryClient.invalidateQueries({ queryKey: ["agent-sessions", props.scope, projectId] });
      void queryClient.invalidateQueries({ queryKey: ["agent-session-messages"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const sendMessageMutation = useMutation({
    mutationFn: async () => {
      if (!selectedSessionId) {
        throw new Error("Create or select a session first");
      }
      const message = draftMessage.trim();
      if (!message) {
        throw new Error("Message is required");
      }
      const response = await postAgentMessage(selectedSessionId, message);
      return response;
    },
    onSuccess: () => {
      setDraftMessage("");
      void queryClient.invalidateQueries({ queryKey: ["agent-sessions", props.scope, projectId] });
      void queryClient.invalidateQueries({ queryKey: ["agent-session-messages", selectedSessionId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const approveActionMutation = useMutation({
    mutationFn: ({ sessionId, actionId }: { sessionId: string; actionId: string }) =>
      approveAgentAction(sessionId, actionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-sessions", props.scope, projectId] });
      void queryClient.invalidateQueries({ queryKey: ["agent-session-messages", selectedSessionId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const rejectActionMutation = useMutation({
    mutationFn: ({ sessionId, actionId }: { sessionId: string; actionId: string }) =>
      rejectAgentAction(sessionId, actionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-sessions", props.scope, projectId] });
      void queryClient.invalidateQueries({ queryKey: ["agent-session-messages", selectedSessionId] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  const actions = messagesQuery.data?.actions ?? [];
  const pendingActions = actions.filter((action) => action.status === "PENDING");

  return (
    <div>
      <PageTitle
        title={props.scope === "GLOBAL" ? "Global Agent Chat" : "Project Agent Chat"}
        description={scopeDescription(props.scope, projectId)}
      />

      <div className="grid gap-4 lg:grid-cols-[320px,1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Sessions</CardTitle>
            <CardDescription>Persistent chat threads with approval history.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                placeholder="New session title (optional)"
              />
              <Button
                type="button"
                onClick={() => createSessionMutation.mutate()}
                disabled={createSessionMutation.isPending}
              >
                New
              </Button>
            </div>
            <div className="max-h-[480px] space-y-2 overflow-auto">
              {(sessionsQuery.data ?? []).map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={`w-full rounded-md border p-2 text-left ${
                    session.id === selectedSessionId ? "border-primary bg-primary/5" : "border-border"
                  }`}
                  onClick={() => setSelectedSessionId(session.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{session.title}</p>
                    {session.pendingActionCount ? (
                      <Badge variant="warning">{session.pendingActionCount}</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{session.lastMessagePreview ?? "No messages yet"}</p>
                </button>
              ))}
              {(sessionsQuery.data?.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground">No sessions yet.</p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{activeSession?.title ?? "Select or create a session"}</CardTitle>
            <CardDescription>
              {activeSession ? `Session ${activeSession.id.slice(0, 8)} • ${activeSession.scope}` : "No active session"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {activeSession ? (
              <div className="flex items-center justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => archiveSessionMutation.mutate(activeSession.id)}
                  disabled={archiveSessionMutation.isPending}
                >
                  Archive Session
                </Button>
              </div>
            ) : null}

            {pendingActions.length > 0 ? (
              <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
                <p className="text-sm font-medium">Pending approvals</p>
                {pendingActions.map((action) => (
                  <div key={action.id} className="rounded-md border border-border bg-background p-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm">{action.summary}</p>
                      <Badge variant={actionStatusVariant(action.status)}>{action.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(action.requestedAt).toLocaleString()}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          if (!selectedSessionId) {
                            return;
                          }
                          approveActionMutation.mutate({
                            sessionId: selectedSessionId,
                            actionId: action.id
                          });
                        }}
                        disabled={approveActionMutation.isPending || !selectedSessionId}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (!selectedSessionId) {
                            return;
                          }
                          rejectActionMutation.mutate({
                            sessionId: selectedSessionId,
                            actionId: action.id
                          });
                        }}
                        disabled={rejectActionMutation.isPending || !selectedSessionId}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="max-h-[420px] space-y-2 overflow-auto rounded-md border border-border bg-muted/10 p-3">
              {(messagesQuery.data?.messages ?? []).map((message) => (
                <div key={message.id} className="rounded-md border border-border bg-background p-3">
                  <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{message.role}</span>
                    <span>{new Date(message.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                </div>
              ))}
              {(messagesQuery.data?.messages.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">No messages yet.</p>
              ) : null}
            </div>

            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                sendMessageMutation.mutate();
              }}
            >
              <Textarea
                value={draftMessage}
                onChange={(event) => setDraftMessage(event.target.value)}
                placeholder={
                  props.scope === "PROJECT"
                    ? 'Ask about this project state or request an action (e.g. "redeploy this project").'
                    : "Ask about factory status, projects, PR queues, runs, and actions."
                }
                rows={4}
              />
              <div className="flex justify-end">
                <Button type="submit" disabled={sendMessageMutation.isPending || !activeSession}>
                  Send
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function GlobalAgentChatPage() {
  return <AgentChatPageBase scope="GLOBAL" />;
}

export function ProjectAgentChatPage() {
  return <AgentChatPageBase scope="PROJECT" />;
}
