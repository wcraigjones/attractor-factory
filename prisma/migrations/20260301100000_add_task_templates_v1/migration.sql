-- Add task templates (global + project), event ledger, and run linkage.

-- Create enums
DO $$ BEGIN
  CREATE TYPE "TaskTemplateEnvironmentMode" AS ENUM ('PROJECT_DEFAULT', 'NAMED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "TaskTemplateLaunchMode" AS ENUM ('MANUAL', 'SCHEDULE', 'EVENT', 'REPLAY');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create global task templates catalog
CREATE TABLE "GlobalTaskTemplate" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "attractorName" TEXT NOT NULL,
  "runType" "RunType" NOT NULL,
  "sourceBranch" TEXT,
  "targetBranch" TEXT,
  "environmentMode" "TaskTemplateEnvironmentMode" NOT NULL DEFAULT 'PROJECT_DEFAULT',
  "environmentName" TEXT,
  "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
  "scheduleCron" TEXT,
  "scheduleTimezone" TEXT,
  "triggersJson" JSONB,
  "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GlobalTaskTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GlobalTaskTemplate_name_key" ON "GlobalTaskTemplate"("name");

-- Create project materialized task templates
CREATE TABLE "TaskTemplate" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "scope" "AttractorScope" NOT NULL DEFAULT 'PROJECT',
  "name" TEXT NOT NULL,
  "attractorName" TEXT NOT NULL,
  "runType" "RunType" NOT NULL,
  "sourceBranch" TEXT,
  "targetBranch" TEXT,
  "environmentMode" "TaskTemplateEnvironmentMode" NOT NULL DEFAULT 'PROJECT_DEFAULT',
  "environmentName" TEXT,
  "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
  "scheduleCron" TEXT,
  "scheduleTimezone" TEXT,
  "scheduleNextRunAt" TIMESTAMP(3),
  "scheduleLastRunAt" TIMESTAMP(3),
  "scheduleLastError" TEXT,
  "triggersJson" JSONB,
  "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TaskTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskTemplate_projectId_name_scope_key" ON "TaskTemplate"("projectId", "name", "scope");
CREATE INDEX "TaskTemplate_projectId_active_scheduleEnabled_scheduleNextRunAt_idx"
  ON "TaskTemplate"("projectId", "active", "scheduleEnabled", "scheduleNextRunAt");
CREATE INDEX "TaskTemplate_projectId_scope_idx" ON "TaskTemplate"("projectId", "scope");

-- Create task template event ledger
CREATE TABLE "TaskTemplateEventLedger" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "taskTemplateId" TEXT NOT NULL,
  "runId" TEXT,
  "eventName" TEXT NOT NULL,
  "eventAction" TEXT,
  "dedupeKey" TEXT NOT NULL,
  "deliveryId" TEXT,
  "entityType" TEXT,
  "entityNumber" INTEGER,
  "matchedRuleIds" JSONB,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL,
  "reason" TEXT,
  "replayedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TaskTemplateEventLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskTemplateEventLedger_taskTemplateId_dedupeKey_key"
  ON "TaskTemplateEventLedger"("taskTemplateId", "dedupeKey");
CREATE INDEX "TaskTemplateEventLedger_projectId_createdAt_idx"
  ON "TaskTemplateEventLedger"("projectId", "createdAt");
CREATE INDEX "TaskTemplateEventLedger_taskTemplateId_createdAt_idx"
  ON "TaskTemplateEventLedger"("taskTemplateId", "createdAt");
CREATE INDEX "TaskTemplateEventLedger_runId_idx"
  ON "TaskTemplateEventLedger"("runId");

-- Extend Run for traceability
ALTER TABLE "Run"
  ADD COLUMN "taskTemplateId" TEXT,
  ADD COLUMN "taskTemplateLaunchMode" "TaskTemplateLaunchMode";

CREATE INDEX "Run_taskTemplateId_idx" ON "Run"("taskTemplateId");

-- Foreign keys
ALTER TABLE "TaskTemplate"
  ADD CONSTRAINT "TaskTemplate_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskTemplateEventLedger"
  ADD CONSTRAINT "TaskTemplateEventLedger_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskTemplateEventLedger"
  ADD CONSTRAINT "TaskTemplateEventLedger_taskTemplateId_fkey"
  FOREIGN KEY ("taskTemplateId") REFERENCES "TaskTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskTemplateEventLedger"
  ADD CONSTRAINT "TaskTemplateEventLedger_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Run"
  ADD CONSTRAINT "Run_taskTemplateId_fkey"
  FOREIGN KEY ("taskTemplateId") REFERENCES "TaskTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
