# Terraform Infrastructure - Delivery Tracker

This document specifies the Terraform infrastructure patterns for deploying Delivery Tracker.

## Overview

Delivery Tracker mirrors estate-drift deployment patterns:
- Jenkins-driven Terraform plan/apply
- EKS + ALB ingress
- Helm `k8s-service` chart
- Platform SSM for environment metadata
- IRSA for backend permissions

## Directory Structure

```
terraform/
├── backend/
│   ├── providers.tf
│   ├── backend.tf
│   ├── data.tf
│   ├── locals.tf
│   ├── variables.tf
│   ├── api.tf
│   ├── network-policies.tf
│   ├── secrets.tf
│   └── main.tf
├── frontend/
│   ├── providers.tf
│   ├── backend.tf
│   ├── data.tf
│   ├── locals.tf
│   ├── variables.tf
│   ├── api.tf
│   └── network-policies.tf
└── modules/
    ├── database/
    ├── s3-buckets/
    └── iam-roles/
```

## State Backend

Managed by your CI/CD pipeline (e.g. Jenkins).

## Services

- **delivery-tracker**: FastAPI backend
- **delivery-tracker-ui**: Vite React frontend

## Secrets

Backend reads DB creds from Secrets Manager via IRSA and injects runtime secrets from Vault.

## Ingress

ALB Ingress configured via Helm chart values in each service root.

## CI/CD

Pipeline in `/Jenkinsfile` mirrors estate-drift pattern:
- Build & promote images
- Terraform plan/apply for backend (infra + API) and frontend (UI)
- Manual prod approval
