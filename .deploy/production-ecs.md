# Production Deployment: AWS ECS

## Status

**Future phase (not current production path).**

Current implemented deployment target is **AWS EKS**:

- [AWS EKS Architecture](./aws-eks-architecture.md)
- [AWS EKS Runbook](./aws-eks-runbook.md)
- [AWS Ops and Scaling](./aws-ops-and-scaling.md)
- [AWS Troubleshooting](./aws-troubleshooting.md)

## Scope

This document describes a production ECS deployment model for Factory.

Important current-state constraint:

- `apps/factory-runner-controller` is Kubernetes Job-native today (`@kubernetes/client-node`, K8s RBAC, Job manifests).
- A fully ECS-native production deployment requires replacing that K8s Job dispatch path with ECS task dispatch.

## Target Architecture (ECS-Native)

Control plane (always-on ECS services, Fargate):

- `factory-api` (ECS Service)
- `factory-web` (ECS Service)
- `factory-runner-controller` (ECS Service, refactored for ECS dispatch)

Data plane (managed AWS services):

- Postgres -> Amazon RDS for PostgreSQL
- Redis -> Amazon ElastiCache (Redis)
- MinIO -> Amazon S3 bucket (artifacts)

Networking:

- ALB in front of `factory-web` and `factory-api`
- Path routing:
  - `/api/*` -> `factory-api` target group
  - `/*` -> `factory-web` target group

Secrets:

- AWS Secrets Manager for provider credentials and infra secrets
- Injected into ECS task definitions via `secrets` mappings
- Optional Google SSO gate (all-or-none):
  - `FACTORY_AUTH_GOOGLE_CLIENT_ID`
  - `FACTORY_AUTH_GOOGLE_CLIENT_SECRET`
  - `FACTORY_AUTH_ALLOWED_DOMAIN`
  - `FACTORY_AUTH_SESSION_SECRET`
- If all four are unset, Factory remains open.
- If partially configured, `factory-api`/`factory-web` should fail fast at startup.
- With auth enabled, only `GET /healthz` and `POST /api/github/webhooks` remain public.

Per-run execution:

- Runner tasks launched with `ecs:RunTask` (one task per run)
- Equivalent of current K8s Job semantics

## Required Code Changes for ECS

## 1. Environment Kind Extension

Current enum expects `KUBERNETES_JOB`.

Add ECS variant in shared types and persistence:

- `ECS_TASK` environment kind
- ECS execution settings (cluster, task definition family, launch type, subnet/security groups)

## 2. Runner Controller Dispatch Refactor

Replace K8s dispatch path:

- remove `buildRunnerJobManifest` dependency for ECS code path
- call AWS ECS `RunTask` using AWS SDK
- pass `RUN_EXECUTION_SPEC` + runtime env vars as task overrides
- tag tasks with `runId`, `projectId`, `runType`

Keep branch lock and queue logic unchanged:

- Redis queue / cancellation semantics remain
- branch lock behavior for implementation runs remains

## 3. Secrets Projection

Current code uses K8s secret env materialization.

ECS path should:

- resolve provider secret mappings from DB
- fetch secret values from Secrets Manager/SSM
- inject as ECS task env/secrets

## 4. Artifact Backend

Use S3 directly (already S3-compatible usage exists in runner):

- set bucket, region, and IAM role permissions
- remove MinIO endpoint override in production

## 5. IAM

Task roles:

- `factory-api` task role:
  - read/write DB, Redis network access
  - Secrets Manager read
- `factory-runner-controller` task role:
  - `ecs:RunTask`
  - `iam:PassRole` for runner task role
  - DB/Redis/Secrets read
- `factory-runner` task role:
  - S3 artifact read/write
  - Secrets read (if needed by providers)

## ECS Infrastructure Blueprint

Core resources:

- ECS cluster (Fargate)
- ALB + listeners + target groups
- CloudWatch log groups
- RDS PostgreSQL
- ElastiCache Redis
- S3 artifact bucket
- Secrets Manager secrets
- VPC with private subnets for ECS tasks and data services

Recommended deployment split:

1. `factory-web` and `factory-api` public behind ALB
2. `factory-runner-controller` internal service
3. `factory-runner` launched as ad-hoc tasks by controller

## Deployment Pipeline (CI/CD)

1. Build and push images to ECR:
   - `factory-api`
   - `factory-web`
   - `factory-runner-controller`
   - `factory-runner`
2. Render and apply ECS task definition revisions
3. Update ECS services (`api`, `web`, `controller`)
4. Run post-deploy smoke checks:
   - `GET /api/healthz`
   - `GET /api/projects`
   - web root load
   - queue a test `task` run and verify artifact write

## Operational Checks

Health:

- ALB target health
- ECS service desired/running task counts
- DB and Redis connectivity from tasks
- S3 artifact upload/download path

Run-path verification:

- run queued -> controller dequeues -> ECS runner task starts
- runner emits events -> run status transitions correctly
- artifact persisted and visible in run detail

## Recommended Migration Order

1. Keep local/dev on Kubernetes unchanged.
2. Deploy `factory-api` + `factory-web` on ECS first.
3. Run controller in ECS but keep K8s dispatch disabled.
4. Implement and enable ECS `RunTask` dispatch path.
5. Cut over artifact and secret backends to AWS managed services.
6. Execute end-to-end run conformance tests (planning/implementation/task).

## Minimal Hybrid Alternative

If full ECS refactor is deferred:

- run `api` + `web` on ECS
- keep `runner-controller` + runners on EKS

This works operationally, but it is not fully ECS-native and adds cross-platform complexity.
