variable "chart_version" {
  type    = string
  default = "v0.2.29"
}

variable "resource_suffix" {
  type        = string
  description = "Suffix used to avoid name collisions (e.g., 000001 for delivery-tracker-ui-v1-000001)."
  default     = "000001"
}

variable "ui_replicas" {
  type    = number
  default = 1
}

variable "service_port" {
  type    = number
  default = 80
}

variable "ingress_scheme" {
  type = string
  validation {
    condition     = contains(["internal", "internet-facing"], var.ingress_scheme)
    error_message = "The ingress scheme must be internal or internet facing."
  }
  default = "internal"
}

variable "ingress_group" {
  type = string
  validation {
    condition     = contains(["default"], var.ingress_group)
    error_message = "The ingress group must be provisioned by platform team."
  }
  default = "default"
}
