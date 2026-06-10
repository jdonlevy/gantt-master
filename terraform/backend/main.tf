locals {
  db_min_capacity = coalesce(var.min_capacity, 1)
  db_max_capacity = coalesce(
    var.max_capacity,
    var.platform_environment == "prod" ? 10 : 4
  )
}

module "database" {
  source = "../modules/database"

  environment             = var.project_environment
  resource_prefix         = local.resource_prefix
  vpc_id                  = data.aws_ssm_parameter.vpc_id.insecure_value
  subnet_ids              = jsondecode(data.aws_ssm_parameter.database_subnets.value)
  allowed_security_groups = [data.aws_ssm_parameter.node_security_group_id.insecure_value]

  database_name           = var.database_name
  engine_version          = var.engine_version
  master_username         = var.master_username
  backup_retention_period = var.backup_retention_period
  min_capacity            = local.db_min_capacity
  max_capacity            = local.db_max_capacity
}

module "s3_buckets" {
  source = "../modules/s3-buckets"

  environment = var.project_environment
  account_id  = data.aws_caller_identity.current.account_id
  resource_prefix = local.resource_prefix
}

module "iam_roles" {
  source = "../modules/iam-roles"

  environment                   = var.project_environment
  eks_cluster_oidc_issuer_url   = data.aws_ssm_parameter.oidc_issuer_url.insecure_value
  eks_cluster_oidc_provider_arn = data.aws_ssm_parameter.oidc_provider_arn.insecure_value
  namespace                     = var.namespace
  db_secret_arn                 = module.database.secret_arn
  documents_bucket_arn          = module.s3_buckets.documents_bucket_arn
  permissions_boundary_arn      = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/releaser-policy-boundary"
  resource_prefix               = local.resource_prefix
}

output "database_endpoint" {
  value     = module.database.cluster_endpoint
  sensitive = true
}

output "database_secret_arn" {
  value = module.database.secret_arn
}

output "documents_bucket" {
  value = module.s3_buckets.documents_bucket_name
}

output "backend_role_arn" {
  value = module.iam_roles.backend_role_arn
}
