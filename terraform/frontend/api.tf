resource "helm_release" "frontend" {
  name       = local.ui_name
  repository = "https://helmcharts.gruntwork.io"
  chart      = "k8s-service"
  version    = var.chart_version
  namespace  = var.namespace

  values = [
    yamlencode({
      applicationName = local.ui_name
      replicaCount    = var.ui_replicas
      minAvailable    = 1

      deploymentAnnotations = {
        arch = local.node_arch
      }

      # Pin to x86_64 nodes. The frontend image is built single-arch amd64
      # (see frontend/Dockerfile `FROM --platform=linux/amd64`), so scheduling
      # onto arm64 Graviton nodes causes `exec format error` at container
      # start. Remove once the image is published as a multi-arch manifest.
      nodeSelector = {
        "kubernetes.io/arch" = local.node_arch
      }

      containerImage = {
        repository = "${var.platform_account_id}.dkr.ecr.eu-west-1.amazonaws.com/${var.platform_environment}/${var.namespace}/${local.ui_name}"
        tag        = data.aws_ssm_parameter.app_version.insecure_value
        pullPolicy = "IfNotPresent"
      }

      envVars = {
        VITE_API_BASE_URL = "https://${local.backend_domain}"
      }

      # AAD values come from the shared `delivery-tracker-aad` k8s Secret
      # created in the backend Terraform root (terraform/backend/azuread.tf,
      # module.managed_secrets_aad). The backend root applies first per the
      # Jenkinsfile, so the Secret already exists by the time this Helm
      # release reconciles.
      secrets = {
        "delivery-tracker-aad" = {
          as = "environment"
          items = {
            azure_ad_client_id = { envVarName = "VITE_AZURE_AD_CLIENT_ID" }
            azure_ad_tenant_id = { envVarName = "VITE_AZURE_AD_TENANT_ID" }
            azure_ad_authority = { envVarName = "VITE_AZURE_AD_AUTHORITY" }
          }
        }
      }

      containerPorts = {
        http = { port = var.service_port }
      }

      service = {
        ports = {
          app = { port = var.service_port }
        }
      }

      containerResources = {
        requests = {
          memory = "128Mi"
          cpu    = "100m"
        }
        limits = {
          memory = "256Mi"
          cpu    = "250m"
        }
      }

      livenessProbe = {
        initialDelaySeconds = 30
        periodSeconds       = 10
        failureThreshold    = 9
        tcpSocket           = { port = var.service_port }
      }

      readinessProbe = {
        initialDelaySeconds = 30
        periodSeconds       = 10
        failureThreshold    = 9

        httpGet = {
          path = "/"
          port = var.service_port
        }
      }

      ingress = {
        enabled     = true
        path        = "/"
        pathType    = "Prefix"
        servicePort = var.service_port
        hosts = [
          local.ui_domain
        ]
        annotations = {
          "alb.ingress.kubernetes.io/scheme"                       = var.ingress_scheme
          "alb.ingress.kubernetes.io/group.name"                   = var.ingress_group
          "alb.ingress.kubernetes.io/target-type"                  = "ip"
          "alb.ingress.kubernetes.io/group.order"                  = "20"
          "alb.ingress.kubernetes.io/healthcheck-path"             = "/"
          "alb.ingress.kubernetes.io/healthcheck-interval-seconds" = "10"
        }
      }
    })
  ]
}
