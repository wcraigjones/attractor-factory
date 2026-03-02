# AWS Troubleshooting

## 1) Certificate stuck in `PENDING_VALIDATION`

Checks:

```bash
aws --profile ai-sandbox-administrator --region us-west-2 acm list-certificates
aws --profile ai-sandbox-administrator --region us-west-2 acm describe-certificate --certificate-arn <cert-arn>
```

Actions:

- confirm Route53 hosted zone `pelx.ai` exists in account `582719176192`
- confirm certificate stack received correct `HostedZoneId`
- re-run:

```bash
./scripts/aws/deploy-infra.sh
```

## 2) Ingress has no ALB hostname

Checks:

```bash
kubectl -n factory-system get ingress factory-system -o yaml
kubectl -n kube-system get deploy aws-load-balancer-controller
kubectl -n kube-system logs deploy/aws-load-balancer-controller --tail=200
```

Actions:

- ensure ALB controller deployment is healthy
- ensure subnet tags exist:
  - `kubernetes.io/cluster/<cluster-name>=shared`
  - `kubernetes.io/role/elb=1` (public)
- re-run:

```bash
./scripts/aws/install-alb-controller.sh
./scripts/aws/deploy-app.sh
```

## 3) Pods in `CrashLoopBackOff`

Checks:

```bash
kubectl -n factory-system get pods
kubectl -n factory-system describe pod <pod>
kubectl -n factory-system logs <pod> --previous
```

Likely causes:

- bad image tag or image pull permission issue
- invalid env/secret wiring
- DB/Redis/MinIO startup race
- Postgres data dir mountpoint issue (fix is `PGDATA=/var/lib/postgresql/data/pgdata`, already in chart)
- runtime path mismatch in container command

Actions:

- verify ECR images exist for `IMAGE_TAG`
- redeploy images then app:

```bash
IMAGE_TAG=<tag> ./scripts/aws/build-push.sh
IMAGE_TAG=<tag> ./scripts/aws/deploy-app.sh
```

## 4) ECR auth / push failures

Checks:

```bash
aws --profile ai-sandbox-administrator --region us-west-2 sts get-caller-identity
aws --profile ai-sandbox-administrator --region us-west-2 ecr describe-repositories
```

Actions:

- re-login AWS SSO:

```bash
./scripts/aws/login.sh
```

- retry push:

```bash
IMAGE_TAG=<tag> ./scripts/aws/build-push.sh
```

## 5) DNS propagation issues for `factory.pelx.ai`

Checks:

```bash
aws --profile ai-sandbox-administrator --region us-west-2 route53 list-resource-record-sets --hosted-zone-id <zone-id>
dig +short factory.pelx.ai
```

Actions:

- confirm `attractor-factory-dns` stack is `CREATE_COMPLETE`/`UPDATE_COMPLETE`
- verify alias target matches current ingress ALB hostname
- republish DNS after ingress ALB changes:

```bash
./scripts/aws/publish-dns.sh
```

## 6) CloudFormation stack rollback

Checks:

```bash
aws --profile ai-sandbox-administrator --region us-west-2 cloudformation describe-stack-events --stack-name <stack-name>
```

Actions:

- inspect first failed resource event
- fix parameters/permissions
- re-run the corresponding deployment script

## 7) Smoke checks failing

Run full health sequence:

```bash
./scripts/aws/smoke-checks.sh
```

If API health fails:

- check `https://factory.pelx.ai/api/models/providers` (API reachability)
- inspect `factory-api` logs
- verify ingress path routing `/api` -> `factory-api`

If web root fails:

- inspect `factory-web` logs
- verify ingress `/` route target

## 8) PVCs stuck `Pending` for `gp3`

Checks:

```bash
kubectl get storageclass
kubectl -n factory-system get pvc
aws --profile ai-sandbox-administrator --region us-west-2 eks describe-addon \
  --cluster-name attractor-factory-eks --addon-name aws-ebs-csi-driver
```

Actions:

- run:

```bash
./scripts/aws/deploy-app.sh
```

- `deploy-app.sh` ensures EBS CSI addon, IRSA role, and `gp3` storage class.

## 9) HPA shows `<unknown>` metrics

Checks:

```bash
kubectl get apiservice v1beta1.metrics.k8s.io
kubectl -n kube-system get deploy metrics-server
kubectl -n factory-system get hpa
```

Actions:

- run:

```bash
./scripts/aws/deploy-app.sh
```

- `deploy-app.sh` installs/updates metrics-server.

## 10) Google sign-in (OIDC) not working

Checks:

```bash
kubectl -n factory-system get ingress factory-system -o yaml | rg 'alb.ingress.kubernetes.io/auth'
kubectl -n factory-system get secret google-oidc
curl -sSI https://factory.pelx.ai/ | head -n 5
```

Actions:

- confirm GCP OAuth client redirect URI exactly matches:
  - `https://factory.pelx.ai/oauth2/idpresponse`
- ensure `GOOGLE_OIDC_CLIENT_ID` and `GOOGLE_OIDC_CLIENT_SECRET` match the client in project `ai-hub-483804`
- redeploy:

```bash
GOOGLE_OIDC_ENABLED=true \
GOOGLE_OIDC_CLIENT_ID=<client-id> \
GOOGLE_OIDC_CLIENT_SECRET=<client-secret> \
./scripts/aws/deploy-app.sh
```
