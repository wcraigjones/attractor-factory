# Attractor

This repository contains [NLSpecs](#terminology) to build your own version of Attractor to create your own software factory.

Although bringing your own agentic loop and unified LLM SDK is not required to build your own Attractor, we highly recommend controlling the stack so you have a strong foundation.

## Specs

- [Attractor Specification](./attractor-spec.md)
- [Coding Agent Loop Specification](./coding-agent-loop-spec.md)
- [Unified LLM Client Specification](./unified-llm-spec.md)

## Building Attractor

Supply the following prompt to a modern coding agent (Claude Code, Codex, OpenCode, Amp, Cursor, etc):

```
codeagent> Implement Attractor as described by https://github.com/strongdm/attractor
```

## Monorepo Layout

- `apps/factory-api`: Control-plane API (projects/secrets/attractors/runs, model catalog, SSE events)
- `apps/factory-web`: Route-based React control surface (shadcn/ui + Monaco artifact viewer)
- `apps/factory-runner-controller`: Redis queue consumer that creates Kubernetes Jobs
- `apps/factory-runner`: Per-run execution worker (planning/implementation baseline)
- `packages/shared-types`: Shared API/runtime contracts and Redis key conventions
- `packages/shared-k8s`: Kubernetes helper logic and secret env projections
- `deploy/helm/factory-system`: OrbStack-focused Helm chart
- `prisma/`: Postgres schema + initial migration
- `factory/self-bootstrap.dot`: baseline self-factory pipeline definition
- `factory/task-review-framework.dot`: review loop template (summary/critical/artifacts/checklist/decision)
- `factory/pr-review-attractor.dot`: PR review attractor (`review_council -> review_summary`)
- `scripts/`: local image build, OrbStack deploy, and self-bootstrap helpers

## Local Setup

```bash
npm install
npm run prisma:generate
npm run check-types
npm run test
```

## Docker Dev/Test Setup

Use the Docker-based workspace (includes Postgres/Redis/MinIO and headless Playwright support) for reproducible local testing:

```bash
docker build -f Dockerfile.dev -t attractor-dev:local .
./scripts/docker/start-dev-deps.sh
./scripts/docker/workspace-shell.sh
```

Full guide: [docs/docker-dev.md](./docs/docker-dev.md)

## Conformance Suite

This repo includes the upstream `fkyeah` conformance suite under `conformance/`.

Run deterministic categories (`01`-`06`) with live-model categories (`07`/`08`) skipped:

```bash
npm run test:conformance
```

Run the full suite (including live-model tests) when API keys are configured:

```bash
ATTRACTOR_BIN=~/bin/attractor npm run test:conformance:all
```

For iterative work (service-by-service):

```bash
npm run dev:api
npm run dev:web
npm run dev:controller
npm run dev:runner
```

## Local OrbStack Bootstrap

Build local images:

```bash
npm run images:build:local
```

Deploy stack to OrbStack Kubernetes:

```bash
npm run k8s:deploy:local
```

The deploy script installs Traefik, applies the factory ingress, and prints direct local Web/API URLs (no port-forward required).

Provider API keys are not required to install or open the UI. The factory boots keyless and you add project-scoped provider keys later from the Web UI (`Project Secrets` page).
The secrets UI and API also support arbitrary key/value secrets that are not tied to an AI provider mapping.

Optional Google SSO access gate:

- Factory stays open if all auth vars below are unset/empty.
- Factory enables Google login gate when all are set:
  - `FACTORY_AUTH_GOOGLE_CLIENT_ID`
  - `FACTORY_AUTH_GOOGLE_CLIENT_SECRET`
  - `FACTORY_AUTH_ALLOWED_DOMAIN` (for example `pelicandynamics.com`; subdomains allowed)
  - `FACTORY_AUTH_SESSION_SECRET`
- Partial configuration is rejected at startup (all-or-none).
- With auth enabled, unauthenticated API requests return `401 {"error":"authentication required"}`.
- Public unauthenticated exceptions in enabled mode: `GET /healthz`, `POST /api/github/webhooks`.

Global shared secrets are also supported from the Web UI (`Global Secrets` page). Global secrets are replicated into each project namespace, and project secrets override global secrets for the same provider.

Global attractors are also supported from the Web UI (`Global Attractors` page). Global attractors are synced into each project, and project attractors with the same name override global attractors in project views and run selection.

Web route map:

- `/`
- `/projects`
- `/environments/global`
- `/attractors/global`
- `/attractors/global/:attractorId`
- `/task-templates/global`
- `/secrets/global`
- `/projects/:projectId`
- `/projects/:projectId/environments`
- `/projects/:projectId/secrets`
- `/projects/:projectId/attractors`
- `/projects/:projectId/attractors/:attractorId`
- `/projects/:projectId/task-templates`
- `/projects/:projectId/github/issues`
- `/projects/:projectId/github/issues/:issueNumber`
- `/projects/:projectId/github/pulls`
- `/projects/:projectId/github/pulls/:prNumber`
- `/projects/:projectId/runs`
- `/runs/:runId`
- `/runs/:runId/artifacts/:artifactId`
- `/auth/google/start` (when auth is enabled)
- `/auth/google/callback` (when auth is enabled)
- `/auth/logout` (when auth is enabled)

## Task Templates (Concept)

Task templates are reusable run launch definitions layered on top of attractors. A template captures defaults such as run type, branch strategy, environment/model overrides, and input mapping.

Templates can be launched in three ways:

- On demand (manual run now)
- Periodically (scheduled runs)
- Event-triggered (for example when a GitHub PR is merged or an issue is opened)

Event-triggered templates should use filters and idempotency keys so webhook retries or replayed sync events do not enqueue duplicate runs.

## Self-Bootstrap Run

After API is reachable (use the `API URL` printed by `npm run k8s:deploy:local`), bootstrap the repo and queue a planning run:

```bash
API_BASE_URL=http://<traefik-ip>/api npm run bootstrap:self
```

Preferred: set provider credentials in the UI (`Project Secrets` page) after project bootstrap.

If a key should be shared across projects, set it once in the UI (`Global Secrets` page) and skip per-project setup unless you need project-specific overrides.

CLI fallback: set provider credentials for the project (required before runs can dispatch):

```bash
PROJECT_ID=<project-id> \
PROVIDER=anthropic \
ANTHROPIC_API_KEY=<key> \
API_BASE_URL=http://<traefik-ip>/api \
npm run set:provider-secret
```

You can also bootstrap and set the provider secret in one command (CLI fallback):

```bash
SET_PROVIDER_SECRET=true \
MODEL_PROVIDER=anthropic \
ANTHROPIC_API_KEY=<key> \
API_BASE_URL=http://<traefik-ip>/api \
npm run bootstrap:self
```

Queue an implementation run from the latest successful planning bundle:

```bash
PROJECT_ID=<project-id> ATTRACTOR_ID=<attractor-id> API_BASE_URL=http://<traefik-ip>/api npm run self:iterate
```

Run the full self-factory loop (bootstrap, secret setup, planning, implementation, wait for completion):

```bash
MODEL_PROVIDER=anthropic \
ANTHROPIC_API_KEY=<key> \
API_BASE_URL=http://<traefik-ip>/api \
npm run self:cycle
```

Install the built-in PR review attractor template:

```bash
API_BASE_URL=http://<traefik-ip>/api npm run attractor:pr-review
```

## LLM Runtime

Attractor now mandates [`@mariozechner/pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai) as the only LLM runtime layer for node execution. No direct provider SDK imports are used in source modules.

## API (MVP Endpoints)

Run the API locally:

```bash
npm run dev:api
```

Implemented endpoints:

- `GET /api/models/providers`
- `GET /api/models?provider=<provider>`
- `GET /api/environments`
- `POST /api/environments`
- `PATCH /api/environments/{environmentId}`
- `POST /api/environments/{environmentId}/shell/sessions`
- `DELETE /api/environments/shell/sessions/{sessionId}`
- `WS /api/environments/shell/sessions/{sessionId}/stream`
- `GET /api/secrets/providers`
- `GET /api/secrets/providers/{provider}`
- `POST /api/secrets/global`
- `GET /api/secrets/global`
- `POST /api/attractors/global`
- `GET /api/attractors/global`
- `GET /api/attractors/global/{attractorId}`
- `PATCH /api/attractors/global/{attractorId}`
- `GET /api/attractors/global/{attractorId}/versions`
- `GET /api/attractors/global/{attractorId}/versions/{version}`
- `POST /api/task-templates/global`
- `GET /api/task-templates/global`
- `GET /api/task-templates/global/{templateId}`
- `PATCH /api/task-templates/global/{templateId}`
- `POST /api/projects`
- `GET /api/projects`
- `POST /api/projects/{projectId}/environment`
- `POST /api/bootstrap/self`
- `GET /api/github/app/status`
- `GET /api/github/app/manifest/start?projectId=<projectId>`
- `GET /api/github/app/start?projectId=<projectId>`
- `GET /api/github/app/callback`
- `POST /api/projects/{projectId}/repo/connect/github`
- `GET /api/projects/{projectId}/github/repos`
- `POST /api/github/webhooks`
- `POST /api/projects/{projectId}/github/reconcile`
- `GET /api/projects/{projectId}/github/issues`
- `GET /api/projects/{projectId}/github/issues/{issueNumber}`
- `POST /api/projects/{projectId}/github/issues/{issueNumber}/runs`
- `GET /api/projects/{projectId}/github/pulls`
- `GET /api/projects/{projectId}/github/pulls/{prNumber}`
- `POST /api/projects/{projectId}/github/pulls/{prNumber}/runs`
- `POST /api/projects/{projectId}/secrets`
- `GET /api/projects/{projectId}/secrets`
- `POST /api/projects/{projectId}/attractors`
- `GET /api/projects/{projectId}/attractors`
- `GET /api/projects/{projectId}/attractors/{attractorId}`
- `PATCH /api/projects/{projectId}/attractors/{attractorId}`
- `GET /api/projects/{projectId}/attractors/{attractorId}/versions`
- `GET /api/projects/{projectId}/attractors/{attractorId}/versions/{version}`
- `POST /api/projects/{projectId}/task-templates`
- `GET /api/projects/{projectId}/task-templates`
- `GET /api/projects/{projectId}/task-templates/{templateId}`
- `PATCH /api/projects/{projectId}/task-templates/{templateId}`
- `POST /api/projects/{projectId}/task-templates/{templateId}/runs`
- `GET /api/projects/{projectId}/task-templates/events`
- `POST /api/projects/{projectId}/task-templates/events/{eventId}/replay`
- `GET /api/projects/{projectId}/runs`
- `POST /api/runs`
- `POST /api/projects/{projectId}/self-iterate`
- `GET /api/runs/{runId}`
- `GET /api/runs/{runId}/events` (SSE)
- `GET /api/runs/{runId}/artifacts`
- `GET /api/runs/{runId}/artifacts/{artifactId}/content`
- `GET /api/runs/{runId}/artifacts/{artifactId}/download`
- `GET /api/runs/{runId}/review`
- `PUT /api/runs/{runId}/review`
- `POST /api/runs/{runId}/cancel`

Environment images must include a tag or digest (for example `ghcr.io/org/runner:latest` or `ghcr.io/org/runner@sha256:...`). Digest pins are recommended for immutable harness execution.

## Prisma

Apply migrations:

```bash
npm run prisma:migrate:dev
```

## Helm (Phase 0 Bootstrap)

Render chart:

```bash
npm run phase0:helm:template
```

Install to OrbStack:

```bash
helm upgrade --install factory-system ./deploy/helm/factory-system \
  --namespace factory-system \
  -f ./deploy/helm/factory-system/values.local-orbstack.yaml
```

## Terminology

- **NLSpec** (Natural Language Spec): a human-readable spec intended to be  directly usable by coding agents to implement/validate behavior.
