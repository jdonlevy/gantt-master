terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.1"
    }
  }
}

variable "environment" {
  type = string
}

variable "eks_cluster_oidc_issuer_url" {
  type = string
}

variable "eks_cluster_oidc_provider_arn" {
  type = string
}

variable "namespace" {
  type = string
}

variable "db_secret_arn" {
  type = string
}

variable "documents_bucket_arn" {
  type = string
}

variable "permissions_boundary_arn" {
  type    = string
  default = null
}

variable "resource_prefix" {
  type    = string
  default = "delivery-tracker"
}

locals {
  backend_service_account = "delivery-tracker"
}

resource "aws_iam_role" "backend" {
  name = "${var.resource_prefix}-backend-${var.environment}"

  permissions_boundary = var.permissions_boundary_arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = var.eks_cluster_oidc_provider_arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "${replace(var.eks_cluster_oidc_issuer_url, "https://", "")}:sub" = "system:serviceaccount:${var.namespace}:${local.backend_service_account}"
            "${replace(var.eks_cluster_oidc_issuer_url, "https://", "")}:aud" = "sts.amazonaws.com"
          }
        }
      }
    ]
  })

  tags = {
    Name        = "${var.resource_prefix}-backend-${var.environment}"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_iam_role_policy" "backend_policy" {
  name = "${var.resource_prefix}-backend-${var.environment}-policy"
  role = aws_iam_role.backend.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ],
        Resource = [var.db_secret_arn]
      },
      {
        Effect = "Allow",
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ],
        Resource = [
          var.documents_bucket_arn,
          "${var.documents_bucket_arn}/*"
        ]
      },
      {
        Effect = "Allow",
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ],
        Resource = "arn:aws:logs:*:*:log-group:/aws/delivery-tracker/${var.environment}/*"
      }
    ]
  })
}

output "backend_role_arn" {
  value = aws_iam_role.backend.arn
}

 
