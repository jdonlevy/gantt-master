locals {
  api_name = "delivery-tracker"
  ui_name  = "delivery-tracker-ui"
  resource_prefix = "${local.api_name}-v1-${var.resource_suffix}"

  api_domain = "${local.api_name}-${var.namespace}.${data.aws_ssm_parameter.dns_zone_name.insecure_value}"
  ui_domain  = "${local.ui_name}-${var.namespace}.${data.aws_ssm_parameter.dns_zone_name.insecure_value}"
  ui_base_url = var.ui_base_url != "" ? var.ui_base_url : "https://${local.ui_domain}"
  cors_origins = var.cors_origins != "" ? var.cors_origins : local.ui_base_url
  backend_image_repository = "${var.platform_account_id}.dkr.ecr.eu-west-1.amazonaws.com/${var.platform_environment}/${var.namespace}/${local.api_name}"
  backend_image_tag = data.aws_ssm_parameter.app_version.insecure_value
  jira_oauth_redirect_uri = try(
    element(
      compact([
        lookup(data.vault_generic_secret.dt.data, "DT_JIRA_OAUTH_REDIRECT_URI", ""),
        lookup(data.vault_generic_secret.dt.data, "jira_oauth_redirect_uri", ""),
      ]),
      0
    ),
    "https://${local.api_domain}/api/callback"
  )

  environment_map = {
    dev     = "development"
    qa      = "staging"
    preprod = "staging"
    prod    = "production"
  }

  app_environment = lookup(local.environment_map, var.project_environment, var.project_environment)
}
