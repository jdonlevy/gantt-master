# Delivery Tracker - Terraform Infrastructure

This directory contains Terraform configurations for Delivery Tracker.

## Structure

```
terraform/
├── backend/            # Backend API + infra (database, IAM, buckets)
├── frontend/           # Frontend UI service
└── modules/            # Reusable Terraform modules
```

## Prerequisites

1. AWS account access
2. EKS cluster with OIDC provider
3. Platform SSM parameters configured
4. Terraform backend configured (S3 + DynamoDB or equivalent)

## Usage

```bash
cd terraform/backend
terraform init
terraform plan
terraform apply
```

Use a distinct workspace for backend state (for example `delivery-tracker-backend`).

```bash
cd terraform/frontend
terraform init
terraform plan
terraform apply
```

Use a distinct workspace for frontend state (for example `delivery-tracker-frontend`).

## Notes

- Use your CI/CD pipeline (e.g. Jenkins) for plans and applies.
- Helm chart: `k8s-service` from Gruntwork.
