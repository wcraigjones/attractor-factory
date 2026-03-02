# AWS EKS Deployment Runbook

## Prerequisites

Required CLIs:

- `aws` CLI v2+
- `kubectl` v1.30+ (client)
- `helm` v3+
- `docker` v24+
- `jq`
- `curl`

AWS assumptions:

- profile: `ai-sandbox-administrator`
- account: `582719176192`
- region: `us-west-2`
- public hosted zone: `pelx.ai` in same account

## Environment contract

See [aws-env.example](./aws-env.example) for all optional overrides.

## Login (exact command)

```bash
AWS_PROFILE=ai-sandbox-administrator ./scripts/aws/login.sh
```

## One-command deployment

```bash
./scripts/aws/deploy-all.sh
```

## Step-by-step deployment

1. Login:

```bash
./scripts/aws/login.sh
```

2. Deploy CloudFormation infra:

```bash
./scripts/aws/deploy-infra.sh
```

3. Install AWS Load Balancer Controller:

```bash
./scripts/aws/install-alb-controller.sh
```

4. Build and push images to ECR:

```bash
IMAGE_TAG=$(git rev-parse --short HEAD) ./scripts/aws/build-push.sh
```

5. Deploy Helm release:

```bash
IMAGE_TAG=$(git rev-parse --short HEAD) ./scripts/aws/deploy-app.sh
```

`deploy-app.sh` also ensures:

- EBS CSI addon (`aws-ebs-csi-driver`) with IRSA role for gp3 PVC provisioning
- `metrics-server` for HPA metrics
- `gp3` StorageClass (CSI provisioner)

Optional: enforce Google sign-in at ALB (OIDC):

1. In GCP project `ai-hub-483804`, create a Web OAuth client with redirect URI:
   - `https://factory.pelx.ai/oauth2/idpresponse`
2. Export client credentials and deploy:

```bash
GOOGLE_OIDC_ENABLED=true \
GOOGLE_OIDC_CLIENT_ID=<google-oauth-client-id> \
GOOGLE_OIDC_CLIENT_SECRET=<google-oauth-client-secret> \
IMAGE_TAG=$(git rev-parse --short HEAD) \
./scripts/aws/deploy-app.sh
```

6. Publish DNS alias:

```bash
./scripts/aws/publish-dns.sh
```

7. Run smoke checks:

```bash
./scripts/aws/smoke-checks.sh
```

## Pre-deploy validation gates

Run these before first apply or after template/script edits:

```bash
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation validate-template --template-body file://deploy/cloudformation/network.yaml
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation validate-template --template-body file://deploy/cloudformation/eks.yaml
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation validate-template --template-body file://deploy/cloudformation/ecr.yaml
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation validate-template --template-body file://deploy/cloudformation/certificate.yaml
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation validate-template --template-body file://deploy/cloudformation/dns-record.yaml
```

```bash
helm lint deploy/helm/factory-system
helm template factory-system deploy/helm/factory-system -f deploy/helm/factory-system/values.aws-eks.yaml >/tmp/factory-system-aws-render.yaml
for f in scripts/aws/*.sh; do bash -n "$f"; done
```

## Post-deploy acceptance checks

1. AWS identity:

```bash
aws --profile ai-sandbox-administrator --region us-west-2 sts get-caller-identity
```

2. CloudFormation stack statuses:

```bash
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation describe-stacks \
  --stack-name attractor-factory-network --query 'Stacks[0].StackStatus' --output text
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation describe-stacks \
  --stack-name attractor-factory-eks --query 'Stacks[0].StackStatus' --output text
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation describe-stacks \
  --stack-name attractor-factory-ecr --query 'Stacks[0].StackStatus' --output text
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation describe-stacks \
  --stack-name attractor-factory-cert --query 'Stacks[0].StackStatus' --output text
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation describe-stacks \
  --stack-name attractor-factory-dns --query 'Stacks[0].StackStatus' --output text
```

3. Kubernetes readiness:

```bash
kubectl -n factory-system get pods
kubectl -n factory-system get ingress factory-system
```

4. Endpoint checks:

```bash
curl -fsS https://factory.pelx.ai/healthz
curl -fsS https://factory.pelx.ai/api/models/providers
curl -fsSI https://factory.pelx.ai/
```

If Google OIDC auth is enabled, unauthenticated checks should redirect to Google instead:

```bash
curl -sSI https://factory.pelx.ai/ | grep -i '^location: https://accounts.google.com/'
```

5. Optional run-path check:

```bash
PROJECT_ID=<project-id> ATTRACTOR_ID=<attractor-id> ./scripts/aws/smoke-checks.sh
```

## Rollback

### Application rollback only

Rollback Helm revision:

```bash
helm -n factory-system history factory-system
helm -n factory-system rollback factory-system <revision>
```

Or remove app workloads:

```bash
helm uninstall factory-system -n factory-system
```

### Infrastructure rollback

Delete stacks in this order:

```bash
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation delete-stack --stack-name attractor-factory-dns
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation delete-stack --stack-name attractor-factory-cert
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation delete-stack --stack-name attractor-factory-eks
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation delete-stack --stack-name attractor-factory-ecr
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation delete-stack --stack-name attractor-factory-network
```

Wait for completion between dependent stack deletions.

## Notes

- This phase keeps Postgres/Redis/MinIO in-cluster to avoid runtime refactor.
- ECS/Fargate is tracked as future work in [production-ecs.md](./production-ecs.md).
