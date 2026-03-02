# factory-system Helm chart

Installs the Kubernetes control-plane stack for Attractor Factory in namespace `factory-system`:

- `factory-api`
- `factory-web`
- `factory-runner-controller`
- `postgres`
- `redis`
- `minio`

## Chart location

```bash
deploy/helm/factory-system
```

## Key values for AWS EKS

- `ingress.annotations`: pass ALB annotations (scheme, cert ARN, redirect, health checks)
- `service.api.annotations`, `service.web.annotations`: per-service annotations
- `images.runner.digest`: optional runner image digest (`sha256:...`) for `RUNNER_IMAGE` defaults
- `postgres.storageClassName`, `redis.storageClassName`, `minio.storageClassName`
- `hpa.api.*`, `hpa.web.*`: optional autoscaling controls

## Render templates

Local values:

```bash
helm template factory-system ./deploy/helm/factory-system \
  -f ./deploy/helm/factory-system/values.local-orbstack.yaml
```

AWS EKS values:

```bash
helm template factory-system ./deploy/helm/factory-system \
  -f ./deploy/helm/factory-system/values.aws-eks.yaml
```

## Install on AWS EKS

Use the automation scripts from `scripts/aws/` for full stack deployment. If deploying chart-only:

```bash
helm upgrade --install factory-system ./deploy/helm/factory-system \
  --namespace factory-system --create-namespace \
  -f ./deploy/helm/factory-system/values.aws-eks.yaml \
  --set images.api.repository=<ecr-api-repo> \
  --set images.api.tag=<image-tag> \
  --set images.web.repository=<ecr-web-repo> \
  --set images.web.tag=<image-tag> \
  --set images.controller.repository=<ecr-controller-repo> \
  --set images.controller.tag=<image-tag> \
  --set images.runner.repository=<ecr-runner-repo> \
  --set images.runner.tag=<image-tag> \
  --set images.runner.digest=<sha256:digest-optional> \
  --set ingress.host=factory.pelx.ai \
  --set ingress.annotations.alb\.ingress\.kubernetes\.io/certificate-arn=<acm-arn>
```

## Install locally (OrbStack)

```bash
helm upgrade --install factory-system ./deploy/helm/factory-system \
  --namespace factory-system --create-namespace \
  -f ./deploy/helm/factory-system/values.local-orbstack.yaml
```

## Uninstall

```bash
helm uninstall factory-system --namespace factory-system
```
