data "aws_ssm_parameter" "dns_zone_name" {
  provider = aws.platform

  name = "/platform/environment/${var.platform_environment}/dns/zone_name"
}

data "aws_ssm_parameter" "alb_subnets_cidr_blocks" {
  provider = aws.platform

  for_each = {
    internal        = "/platform/environment/${var.platform_environment}/network/compute/intra_subnets_cidr_blocks"
    internet-facing = "/platform/environment/${var.platform_environment}/network/compute/public_subnets_cidr_blocks"
  }

  name = each.value
}

data "aws_ssm_parameter" "app_version" {
  provider = aws.platform

  name = "/platform/environment/${var.platform_environment}/app/${var.namespace}/${local.api_name}/version/${local.api_name}"
}

data "aws_ssm_parameter" "vpc_id" {
  provider = aws.platform
  name     = "/platform/environment/${var.platform_environment}/network/compute/vpc_id"
}

data "aws_ssm_parameter" "database_subnets" {
  provider = aws.platform
  name     = "/platform/environment/${var.platform_environment}/network/compute/database_subnets"
}

data "aws_ssm_parameter" "node_security_group_id" {
  provider = aws.platform
  name     = "/platform/environment/${var.platform_environment}/cluster/node_security_group_id"
}

data "aws_ssm_parameter" "oidc_issuer_url" {
  provider = aws.platform
  name     = "/platform/environment/${var.platform_environment}/cluster/cluster_oidc_issuer_url"
}

data "aws_ssm_parameter" "oidc_provider_arn" {
  provider = aws.platform
  name     = "/platform/environment/${var.platform_environment}/cluster/oidc_provider_arn"
}

data "aws_region" "current" {
  provider = aws.platform
}

data "aws_caller_identity" "current" {}
