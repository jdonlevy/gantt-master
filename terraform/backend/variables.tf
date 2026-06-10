variable "chart_version" {
  type    = string
  default = "v0.2.29"
}

# ---------------------------------------------------------------------------
# Resource naming
# ---------------------------------------------------------------------------

variable "resource_suffix" {
  type        = string
  description = "Suffix used to avoid name collisions (e.g., 000001 for delivery-tracker-v1-000001)."
  default     = "000001"
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

variable "database_name" {
  type    = string
  default = "delivery_tracker"
}

variable "engine_version" {
  type    = string
  default = "16.11"
}

variable "master_username" {
  type    = string
  default = "delivery_tracker_admin"
}

variable "backup_retention_period" {
  type    = number
  default = 7
}

variable "min_capacity" {
  type    = number
  default = 0.5
}

variable "max_capacity" {
  type    = number
  default = 4
}

# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------

variable "api_replicas" {
  # Multi-replica is safe: cross-pod SSE fanout flows
  # through Postgres LISTEN/NOTIFY (backend/app/events_bus.py), so two
  # users on different pods still see each other's live edits. See
  # docs/cross-pod-sse.md for the architecture and the swap-to-Redis
  # triggers if traffic ever outgrows the NOTIFY transport.
  type    = number
  default = 2
}

variable "service_port" {
  type    = number
  default = 8000
}

variable "healthcheck_path" {
  type    = string
  default = "/health"
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

variable "cors_origins" {
  type    = string
  default = ""
}

variable "ui_base_url" {
  type    = string
  default = ""
}

variable "bootstrap_admins" {
  type        = string
  description = "Comma-separated list of emails granted admin role on first login when no admin exists yet."
  default     = ""
}

variable "azure_ad_owner_upn" {
  type        = string
  description = "User principal name of the Azure AD user who owns the app registration."
  default     = ""
}
