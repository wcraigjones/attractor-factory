# Docker Dev/Test Environment

This repo includes a dedicated Docker development environment that supports:

- Iterating on source code with the workspace mounted from your host.
- Running unit/conformance tooling in a reproducible container.
- Running headless Playwright for browser testing and screenshots/snapshots.

## 1. Build the dev image

From the repo root:

```bash
docker build -f Dockerfile.dev -t attractor-dev:local .
```

## 2. Start dependency containers (no Compose)

From the repo root:

```bash
./scripts/docker/start-dev-deps.sh
```

This starts `postgres`, `redis`, and `minio` on a Docker network named `attractor-dev`.

## 3. Open a workspace shell in the dev image

From the repo root:

```bash
./scripts/docker/workspace-shell.sh
```

The workspace entrypoint auto-runs `npm ci` and `npm run prisma:generate` when needed.
You can also run one-off commands without an interactive shell, for example:

```bash
./scripts/docker/workspace-shell.sh npm test
```

## 4. Prepare DB schema (first run or after migration changes)

Inside the container shell:

```bash
npm run prisma:migrate:deploy
```

## 5. Run tests inside Docker

Inside the container shell:

```bash
npm run check-types
npm test
npm run test:conformance
```

## 6. Run the project for local testing

Open two shells with:

```bash
./scripts/docker/workspace-shell.sh
```

Shell A:

```bash
npm run dev:api
```

Shell B:

```bash
npm run dev:web -- --host 0.0.0.0 --port 5173
```

Then use:

- Web UI: `http://localhost:5173`
- API: `http://localhost:8080`

## 7. Headless Playwright testing and snapshots

Run these inside the workspace shell while the web app is running.

Create output folder:

```bash
mkdir -p output/playwright
```

Take a headless Chromium screenshot:

```bash
playwright screenshot \
  --browser=chromium \
  http://127.0.0.1:5173 \
  output/playwright/home.png
```

Use `playwright-cli` for interactive terminal-driven snapshots:

```bash
playwright-cli open http://127.0.0.1:5173
playwright-cli snapshot
```

## 8. Stop and clean up

Stop dependency containers:

```bash
./scripts/docker/stop-dev-deps.sh
```

Also remove the Docker network:

```bash
REMOVE_NETWORK=1 ./scripts/docker/stop-dev-deps.sh
```
