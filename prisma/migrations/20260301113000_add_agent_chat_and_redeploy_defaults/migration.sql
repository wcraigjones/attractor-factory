-- Add enums for agent sessions/actions.
CREATE TYPE "AgentScope" AS ENUM ('GLOBAL', 'PROJECT');
CREATE TYPE "AgentMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');
CREATE TYPE "AgentActionStatus" AS ENUM ('PENDING', 'EXECUTED', 'REJECTED', 'FAILED');
CREATE TYPE "AgentActionRisk" AS ENUM ('LOW', 'HIGH');

-- Extend Project with deterministic redeploy defaults.
ALTER TABLE "Project"
  ADD COLUMN "redeployAttractorId" TEXT,
  ADD COLUMN "redeploySourceBranch" TEXT,
  ADD COLUMN "redeployTargetBranch" TEXT,
  ADD COLUMN "redeployEnvironmentId" TEXT;

CREATE INDEX "Project_redeployAttractorId_idx" ON "Project"("redeployAttractorId");
CREATE INDEX "Project_redeployEnvironmentId_idx" ON "Project"("redeployEnvironmentId");

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_redeployAttractorId_fkey"
  FOREIGN KEY ("redeployAttractorId") REFERENCES "AttractorDef"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_redeployEnvironmentId_fkey"
  FOREIGN KEY ("redeployEnvironmentId") REFERENCES "Environment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Persist chat sessions/history/actions.
CREATE TABLE "AgentSession" (
  "id" TEXT NOT NULL,
  "scope" "AgentScope" NOT NULL,
  "projectId" TEXT,
  "title" TEXT NOT NULL,
  "createdByEmail" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentMessage" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "role" "AgentMessageRole" NOT NULL,
  "content" TEXT NOT NULL,
  "partsJson" JSONB,
  "tokenUsageJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentAction" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "messageId" TEXT,
  "type" TEXT NOT NULL,
  "risk" "AgentActionRisk" NOT NULL,
  "status" "AgentActionStatus" NOT NULL DEFAULT 'PENDING',
  "summary" TEXT NOT NULL,
  "argsJson" JSONB NOT NULL,
  "resultJson" JSONB,
  "error" TEXT,
  "requestedByEmail" TEXT,
  "resolvedByEmail" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentSession_scope_projectId_updatedAt_idx" ON "AgentSession"("scope", "projectId", "updatedAt");
CREATE INDEX "AgentSession_projectId_createdAt_idx" ON "AgentSession"("projectId", "createdAt");
CREATE INDEX "AgentMessage_sessionId_createdAt_idx" ON "AgentMessage"("sessionId", "createdAt");
CREATE INDEX "AgentAction_sessionId_status_requestedAt_idx" ON "AgentAction"("sessionId", "status", "requestedAt");
CREATE INDEX "AgentAction_messageId_idx" ON "AgentAction"("messageId");

ALTER TABLE "AgentSession"
  ADD CONSTRAINT "AgentSession_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentMessage"
  ADD CONSTRAINT "AgentMessage_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentAction"
  ADD CONSTRAINT "AgentAction_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentAction"
  ADD CONSTRAINT "AgentAction_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "AgentMessage"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
