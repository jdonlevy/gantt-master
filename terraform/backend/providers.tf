provider "helm" {
  kubernetes {
    cluster_ca_certificate = base64decode(data.aws_eks_cluster.platform.certificate_authority[0].data)
    host                   = data.aws_eks_cluster.platform.endpoint
    token                  = data.aws_eks_cluster_auth.platform.token
  }
}

provider "aws" {
  alias   = "platform"
  profile = "platform"

  default_tags {
    tags = {
      environment       = var.platform_environment
      orchestrationroot = "https://github.com/your-org/delivery-tracker"
      product           = var.project_name
      environmenttype   = var.platform_environment == "dev" ? "developer" : contains(["qa", "preprod"], var.platform_environment) ? "testing" : var.platform_environment == "prod" ? "production" : "tag missing"
      productarea       = "CT"
      namespace         = var.namespace
    }
  }
}

provider "kubernetes" {
  cluster_ca_certificate = base64decode(data.aws_eks_cluster.platform.certificate_authority[0].data)
  host                   = data.aws_eks_cluster.platform.endpoint
  token                  = data.aws_eks_cluster_auth.platform.token
}

provider "vault" {}

# Azure AD provider — authenticates via the Vault-sourced shared service
# principal at secret/devops/azuread (see azuread.tf data source).
provider "azuread" {
  client_id     = local.azuread_appid
  client_secret = local.azuread_secret
  tenant_id     = module.common.azure_tenant_id
}

data "aws_eks_cluster" "platform" {
  provider = aws.platform

  name = var.platform_environment
}

data "aws_eks_cluster_auth" "platform" {
  provider = aws.platform

  name = var.platform_environment
}
