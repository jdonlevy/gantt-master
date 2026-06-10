# Azure AD App Registration + shared k8s Secret.
#
# Lives in the backend root so the resulting client_id / tenant_id /
# client_secret can be projected straight into the API pod env vars
# (api.tf) AND into a managed k8s Secret (`delivery-tracker-aad`) that the
# SPA's Helm release mounts from the frontend root. The Jenkinsfile applies
# this root first, so the Secret already exists by the time the frontend
# Helm release tries to reference it — no cross-root data source needed.
#
# Governance: open + in-app roles — `app_role_assignment_required = false`
# lets anyone in the tenant sign in; the in-app Role table (viewer /
# editor / admin) determines what they can do. App roles are declared so
# we can later upgrade to an Azure AD assignment gate without
# re-registering.

data "vault_generic_secret" "azuread" {
  path = "secret/devops/azuread"
}

locals {
  azuread_appid  = data.vault_generic_secret.azuread.data["application-id"]
  azuread_secret = data.vault_generic_secret.azuread.data["secret-id"]

  delivery_tracker_ad_roles = ["DeliveryTrackerAdmin", "DeliveryTrackerUser"]

  # SPA redirect URIs. The React frontend handles the auth-code redirect at
  # /oauth/openid/callback on the UI domain (defined in locals.tf).
  # Localhost entries are dev-only so MSAL can complete the flow against a
  # local frontend running on 3000.
  delivery_tracker_redirect_uris = concat(
    ["https://${local.ui_domain}/oauth/openid/callback"],
    var.project_environment == "dev" ? [
      "http://localhost:3000/oauth/openid/callback",
      "http://127.0.0.1:3000/oauth/openid/callback",
    ] : []
  )
}

data "azuread_user" "owner_platform" {
  user_principal_name = var.azure_ad_owner_upn
}

module "delivery_tracker_app_registration" {
  source = "YOUR_TERRAFORM_MODULE_SOURCE"

  display_name                 = "DeliveryTracker-${var.project_environment}"
  owners                       = [data.azuread_user.owner_platform.object_id]
  spa_redirect_uris            = local.delivery_tracker_redirect_uris
  msgraph_grants               = ["openid", "profile", "email", "offline_access", "User.Read"]
  create_secret                = true
  app_role_assignment_required = false
  app_roles                    = { for r in local.delivery_tracker_ad_roles : r => r }
}

locals {
  azure_ad_client_id     = module.delivery_tracker_app_registration.client_id
  azure_ad_client_secret = module.delivery_tracker_app_registration.client_secret
  azure_ad_tenant_id     = module.common.azure_tenant_id
  azure_ad_authority     = "https://login.microsoftonline.com/${module.common.azure_tenant_id}"
}

# Managed k8s Secret propagating the AAD app credentials to both pods. Same
# values land in DT_AZURE_AD_* on the API pod (api.tf) and VITE_AZURE_AD_*
# on the SPA pod (terraform/frontend/api.tf).
module "managed_secrets_aad" {
  source = "YOUR_MANAGED_SECRETS_MODULE_SOURCE"

  providers = {
    aws = aws.platform
  }

  namespace        = var.namespace
  secrets          = ["delivery-tracker-aad"]
  team             = var.team
  owner            = var.team
  environment_name = var.project_environment

  values = {
    "delivery-tracker-aad" = {
      azure_ad_client_id     = local.azure_ad_client_id
      azure_ad_tenant_id     = local.azure_ad_tenant_id
      azure_ad_client_secret = local.azure_ad_client_secret
      azure_ad_authority     = local.azure_ad_authority
    }
  }
}

output "azure_ad_client_id" {
  description = "Azure AD application (client) ID for delivery-tracker"
  value       = local.azure_ad_client_id
}

output "azure_ad_tenant_id" {
  description = "Azure AD tenant ID"
  value       = local.azure_ad_tenant_id
}
