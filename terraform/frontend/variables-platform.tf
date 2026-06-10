variable "namespace" {
  type        = string
  description = "Kubernetes namespace (tenant namespace) to deploy into."
  default     = "delivery-tracker"
}

variable "platform_account_id" {
  type = string
}

variable "platform_environment" {
  type = string
}

variable "project_account_id" {
  type = string
}

variable "project_name" {
  type    = string
  default = "delivery-tracker"
}

variable "project_environment" {
  type = string
}

variable "team" {
  type    = string
  default = "delivery-tracker"
}
