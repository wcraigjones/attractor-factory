# AWS EKS Architecture

## Account and region

- AWS account: `582719176192`
- AWS profile: `ai-sandbox-administrator`
- AWS region: `us-west-2`
- Primary hostname: `factory.pelx.ai`

## Why EKS now

The runtime is Kubernetes-native today:

- `EnvironmentKind` is `KUBERNETES_JOB`
- runner controller dispatches with Kubernetes Jobs
- API environment shell support depends on Kubernetes APIs

EKS avoids a large runner/controller refactor and gets production online faster.

## CloudFormation stacks

Default stack names:

- `attractor-factory-network`
- `attractor-factory-eks`
- `attractor-factory-ecr`
- `attractor-factory-cert`
- `attractor-factory-dns`

### `network` stack

Creates:

- VPC (`10.42.0.0/16` default)
- 2 public + 2 private subnets across 2 AZs
- Internet gateway + NAT gateway
- public/private route tables
- subnet tags for Kubernetes/AWS LB discovery

Outputs:

- `VpcId`
- `PublicSubnetIds`
- `PrivateSubnetIds`

### `eks` stack

Creates:

- EKS cluster (`attractor-factory-eks` default)
- control-plane and node IAM roles
- managed node group (default `min=2`, `desired=2`, `max=6`)

Outputs:

- `ClusterName`, `ClusterArn`, `ClusterEndpoint`
- `OidcIssuer`
- `NodeRoleArn`

### `ecr` stack

Creates immutable ECR repos with scan-on-push and lifecycle retention:

- `attractor-factory/factory-api`
- `attractor-factory/factory-web`
- `attractor-factory/factory-runner-controller`
- `attractor-factory/factory-runner`

Outputs:

- `ApiRepositoryUri`
- `WebRepositoryUri`
- `ControllerRepositoryUri`
- `RunnerRepositoryUri`

### `cert` stack

Creates ACM DNS-validated cert for `factory.pelx.ai` in `us-west-2`.

Output:

- `CertificateArn`

### `dns` stack

Creates Route53 alias `A` record:

- `factory.pelx.ai` -> ALB hostname from Kubernetes ingress

## Kubernetes/Helm topology

Namespace: `factory-system`

Workloads:

- `factory-api` (Deployment)
- `factory-web` (Deployment)
- `factory-runner-controller` (Deployment)
- `postgres` (StatefulSet + PVC)
- `redis` (StatefulSet + PVC)
- `minio` (StatefulSet + PVC)

Ingress:

- ALB ingress class (`alb`)
- path routing:
  - `/api` -> `factory-api`
  - `/` -> `factory-web`
- TLS via ACM annotation

## Runtime data plane (this phase)

- Postgres: in-cluster stateful storage (gp3)
- Redis: in-cluster stateful storage (gp3)
- MinIO: in-cluster stateful storage (gp3)

Managed data services (RDS/ElastiCache/S3) are intentionally deferred.

## IAM notes

- AWS Load Balancer Controller is installed with IRSA role.
- EBS CSI addon is installed with IRSA role (`AmazonEBSCSIDriverPolicy`).
- EKS node role includes ECR pull permissions.
- Application service accounts remain Kubernetes-native.

## Required addons

- `aws-load-balancer-controller` (installed by `scripts/aws/install-alb-controller.sh`)
- `aws-ebs-csi-driver` (ensured by `scripts/aws/deploy-app.sh`)
- `metrics-server` (ensured by `scripts/aws/deploy-app.sh`)

## Deployment automation entrypoints

- `scripts/aws/deploy-all.sh` (end-to-end)
- `scripts/aws/deploy-infra.sh`
- `scripts/aws/install-alb-controller.sh`
- `scripts/aws/build-push.sh`
- `scripts/aws/deploy-app.sh`
- `scripts/aws/publish-dns.sh`
- `scripts/aws/smoke-checks.sh`
