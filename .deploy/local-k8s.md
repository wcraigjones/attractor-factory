# Local Development: Kubernetes (OrbStack)

## What Gets Deployed

Helm chart: `deploy/helm/factory-system`

Namespace: `factory-system`

Core services:

- `factory-api`
- `factory-web`
- `factory-runner-controller`
- `postgres`
- `redis`
- `minio`
- `traefik` ingress controller (installed by script)

Ingress routing:

- `/api` -> `factory-api:8080`
- `/` -> `factory-web:3000`

## Prerequisites

- OrbStack Kubernetes (or compatible local Kubernetes)
- `kubectl`
- `helm`
- `docker`
- Node 20+

## One-Time Bootstrap

Install dependencies and generate Prisma client:

```bash
npm install
npm run prisma:generate
```

Build local service images:

```bash
npm run images:build:local
```

This creates local tags:

- `attractor/factory-api:dev`
- `attractor/factory-web:dev`
- `attractor/factory-runner-controller:dev`
- `attractor/factory-runner:dev`

Deploy stack to local Kubernetes:

```bash
npm run k8s:deploy:local
```

The script:

- installs/updates Traefik
- installs/updates Helm release `factory-system`
- points chart image repos to local `attractor/*` images
- restarts `factory-api`, `factory-web`, `factory-runner-controller`
- prints `Web URL` and `API URL`

## Verify Deployment

```bash
kubectl -n factory-system get pods
kubectl -n factory-system get svc
kubectl -n factory-system get ingress
```

Expected running workloads:

- Deployments: `factory-api`, `factory-web`, `factory-runner-controller`
- StatefulSets: `postgres`, `redis`, `minio`

## Access Paths

Use the URLs printed by the deploy script, or port-forward:

```bash
kubectl -n factory-system port-forward svc/factory-web 13000:3000
kubectl -n factory-system port-forward svc/factory-api 18080:8080
```

Then browse `http://localhost:13000` and use API at `http://localhost:18080`.

## Data and Secrets (Local)

- Postgres DB: internal service `postgres.factory-system.svc.cluster.local:5432`
- Redis: internal service `redis.factory-system.svc.cluster.local:6379`
- MinIO object store:
  - endpoint: `minio.factory-system.svc.cluster.local:9000`
  - bucket: `factory-artifacts`
  - creds from chart values (`minio-auth` secret)

Provider/model API keys are configured from:

- UI: Global Secrets / Project Secrets
- CLI fallback scripts in `scripts/`

Optional Google SSO gate can be enabled by setting all four Helm values:

- `auth.googleClientId`
- `auth.googleClientSecret`
- `auth.allowedDomain`
- `auth.sessionSecret`

Notes:

- Leaving all four empty keeps Factory open.
- Setting only some values causes `factory-api` and `factory-web` to fail startup.
- With auth enabled, only `GET /healthz` and `POST /api/github/webhooks` stay public.

## Self-Bootstrap a Factory Project

Example:

```bash
API_BASE_URL=http://<traefik-or-local-url>/api npm run bootstrap:self
```

Then queue implementation:

```bash
PROJECT_ID=<project-id> ATTRACTOR_ID=<attractor-id> API_BASE_URL=http://<url>/api npm run self:iterate
```

## Teardown

```bash
helm uninstall factory-system -n factory-system
```

Optional namespace cleanup:

```bash
kubectl delete ns factory-system
```

## Troubleshooting

Pods not ready:

```bash
kubectl -n factory-system get pods
kubectl -n factory-system describe pod <pod-name>
kubectl -n factory-system logs deploy/factory-api
kubectl -n factory-system logs deploy/factory-web
kubectl -n factory-system logs deploy/factory-runner-controller
```

Ingress not reachable:

- verify Traefik service external/local address
- use direct port-forward as fallback

Run dispatch issues:

- verify `factory-runner-controller` logs
- verify project/provider secrets exist
- verify per-run events: `GET /api/runs/{id}/events`
