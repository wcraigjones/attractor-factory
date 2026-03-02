# AWS Ops and Scaling

## Baseline profile

The default profile is HA baseline with low idle cost:

- 2 AZ VPC
- 1 EKS managed node group
- node autoscaling bounds: `min=2`, `desired=2`, `max=6`
- API and Web HPAs enabled in `values.aws-eks.yaml`
- Runner controller fixed at 1 replica

## Scaling controls

### Cluster capacity

`deploy/cloudformation/eks.yaml` parameters:

- `NodeMinSize`
- `NodeDesiredSize`
- `NodeMaxSize`
- `KubernetesVersion`

Example:

```bash
NODE_DESIRED_SIZE=3 NODE_MAX_SIZE=10 ./scripts/aws/deploy-infra.sh
```

Note:

- With the current production requests in `values.aws-eks.yaml`, `desired=2` can be tight during addon startup; use `NODE_DESIRED_SIZE=3` or reduce pod resource requests.

### Pod autoscaling

`deploy/helm/factory-system/values.aws-eks.yaml`:

- `hpa.api.minReplicas/maxReplicas/cpuUtilization/memoryUtilization`
- `hpa.web.minReplicas/maxReplicas/cpuUtilization/memoryUtilization`

Update and apply:

```bash
./scripts/aws/deploy-app.sh
```

### Vertical sizing

Tune under `resources.*` in values file for:

- `api`
- `web`
- `controller`
- `postgres`
- `redis`
- `minio`

## Observability quick checks

```bash
kubectl -n factory-system get pods
kubectl -n factory-system top pods
kubectl get hpa -n factory-system
kubectl -n factory-system logs deploy/factory-api --tail=200
kubectl -n factory-system logs deploy/factory-runner-controller --tail=200
kubectl -n kube-system logs deploy/aws-load-balancer-controller --tail=200
```

## Cost notes (low-idle HA)

Primary recurring cost drivers:

- EKS control plane hourly fee
- 2-3 always-on worker nodes (`desired=2` default, often `3` with current prod sizing)
- NAT gateway hourly + data processing
- EBS volumes for Postgres/Redis/MinIO
- ALB hourly + LCU usage
- Route53 hosted zone/query costs

Low-idle optimization levers:

- move node group from `t3.large` to `t3a.large` or smaller validated type
- keep `NodeDesiredSize` as low as practical but avoid addon starvation
- right-size PVC requests (`postgres/redis/minio`)
- keep HPA thresholds conservative to avoid unnecessary bursts

## Change management

Recommended order for production changes:

1. infra stack changes (non-breaking)
2. image build/push
3. Helm apply with pinned image tag
4. smoke checks
5. optional functional run test

For high-risk upgrades, use temporary canary namespace and separate hostname before production cutover.
