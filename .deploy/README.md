# Deployment Runbooks

This folder contains authoritative deployment docs for Attractor Factory.

## Current production path

- **AWS EKS + CloudFormation + Helm** (implemented in this repo)

## Future path

- **AWS ECS/Fargate** (documented as a future phase; not the current runtime target)

## Runbook index

- [AWS EKS Architecture](./aws-eks-architecture.md)
- [AWS EKS Runbook](./aws-eks-runbook.md)
- [AWS Ops and Scaling](./aws-ops-and-scaling.md)
- [AWS Troubleshooting](./aws-troubleshooting.md)
- [AWS Env Contract](./aws-env.example)
- [Local Kubernetes (OrbStack)](./local-k8s.md)
- [Production ECS (Future Phase)](./production-ecs.md)

## Quick start (AWS EKS)

```bash
./scripts/aws/deploy-all.sh
```

This orchestrates:

1. AWS SSO login (`ai-sandbox-administrator`)
2. CloudFormation stacks (network, EKS, ECR, ACM)
3. AWS Load Balancer Controller install
4. Image build and ECR push
5. Helm deploy to EKS
6. Route53 alias creation for `factory.pelx.ai`
7. Post-deploy smoke checks
