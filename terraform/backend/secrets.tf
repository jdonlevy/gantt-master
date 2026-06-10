data "vault_generic_secret" "dt" {
  path = "secret/${var.namespace}/envs/${var.platform_environment}/dt"
}

locals {
  database_url = module.database.database_url

  jira_oauth_client_id = try(
    element(
      compact([
        lookup(data.vault_generic_secret.dt.data, "DT_JIRA_OAUTH_CLIENT_ID", ""),
        lookup(data.vault_generic_secret.dt.data, "jira_oauth_client_id", ""),
        lookup(data.vault_generic_secret.dt.data, "client_id", ""),
        lookup(data.vault_generic_secret.dt.data, "jira_client_id", ""),
      ]),
      0
    ),
    ""
  )

  jira_oauth_client_secret = try(
    element(
      compact([
        lookup(data.vault_generic_secret.dt.data, "DT_JIRA_OAUTH_CLIENT_SECRET", ""),
        lookup(data.vault_generic_secret.dt.data, "jira_oauth_client_secret", ""),
        lookup(data.vault_generic_secret.dt.data, "client_secret", ""),
        lookup(data.vault_generic_secret.dt.data, "jira_client_secret", ""),
      ]),
      0
    ),
    ""
  )

  session_secret = try(
    element(
      compact([
        lookup(data.vault_generic_secret.dt.data, "DT_SESSION_SECRET", ""),
        lookup(data.vault_generic_secret.dt.data, "session_secret", ""),
      ]),
      0
    ),
    ""
  )

  openai_api_key = data.vault_generic_secret.dt.data["OPENAI_API_KEY"]
}

module "managed_secrets" {
  source = "YOUR_MANAGED_SECRETS_MODULE_SOURCE"

  providers = {
    aws = aws.platform
  }

  namespace        = var.namespace
  secrets          = [local.api_name]
  team             = var.team
  owner            = var.team
  environment_name = var.project_environment

  values = {
    (local.api_name) = {
      dt_database_url          = local.database_url
      jira_oauth_client_id     = local.jira_oauth_client_id
      jira_oauth_client_secret = local.jira_oauth_client_secret
      session_secret           = local.session_secret
      openai_api_key           = local.openai_api_key
    }
  }
}
