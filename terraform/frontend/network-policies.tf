resource "kubernetes_network_policy" "delivery_tracker_frontend" {
  metadata {
    name      = local.ui_resource_name
    namespace = var.namespace
  }

  spec {
    pod_selector {
      match_labels = {
        "app.kubernetes.io/name" = local.ui_name
      }
    }

    policy_types = ["Ingress", "Egress"]

    ingress {
      ports {
        port     = var.service_port
        protocol = "TCP"
      }

      dynamic "from" {
        for_each = toset(jsondecode(data.aws_ssm_parameter.alb_subnets_cidr_blocks[var.ingress_scheme].insecure_value))
        content {
          ip_block {
            cidr = from.value
          }
        }
      }
    }

    ingress {
      from {
        pod_selector {
          match_labels = {
            "app.kubernetes.io/name" = local.api_name
          }
        }
      }

      ports {
        port     = var.service_port
        protocol = "TCP"
      }
    }

    egress {
      ports {
        port     = 443
        protocol = "TCP"
      }

      to {
        ip_block {
          cidr = "0.0.0.0/0"
        }
      }
    }

    egress {
      to {
        pod_selector {
          match_labels = {
            "app.kubernetes.io/name" = local.api_name
          }
        }
      }
    }
  }
}
