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

  name = "/platform/environment/${var.platform_environment}/app/${var.namespace}/${local.ui_name}/version/${local.ui_name}"
}
