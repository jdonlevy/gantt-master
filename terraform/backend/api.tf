resource "helm_release" "backend" {
  name       = local.api_name
  repository = "https://helmcharts.gruntwork.io"
  chart      = "k8s-service"
  version    = var.chart_version
  namespace  = var.namespace

  values = [
    yamlencode({
      applicationName = local.api_name

      replicaCount = var.api_replicas

      containerImage = {
        repository = local.backend_image_repository
        tag        = local.backend_image_tag
      }

      serviceAccount = {
        create = true
        name   = local.api_name
      }

      envVars = {
        ENVIRONMENT                = local.app_environment
        OTEL_SERVICE_NAME          = local.api_name
        DT_CORS_ORIGINS            = local.cors_origins
        DT_UI_BASE_URL             = local.ui_base_url
        DT_JIRA_OAUTH_REDIRECT_URI = local.jira_oauth_redirect_uri
        DT_BOOTSTRAP_ADMINS        = var.bootstrap_admins
      }

      secrets = {
        (local.api_name) = {
          as = "environment"
          items = {
            dt_database_url          = { envVarName = "DT_DATABASE_URL" }
            jira_oauth_client_id     = { envVarName = "DT_JIRA_OAUTH_CLIENT_ID" }
            jira_oauth_client_secret = { envVarName = "DT_JIRA_OAUTH_CLIENT_SECRET" }
            session_secret           = { envVarName = "DT_SESSION_SECRET" }
            openai_api_key           = { envVarName = "OPENAI_API_KEY" }
          }
        }
        # AAD values come straight from the azuread-application module
        # outputs via the managed k8s Secret created next to it in
        # azuread.tf. The SPA's Helm release in terraform/frontend/api.tf
        # mounts the same Secret by name.
        "delivery-tracker-aad" = {
          as = "environment"
          items = {
            azure_ad_client_id = { envVarName = "DT_AZURE_AD_CLIENT_ID" }
            azure_ad_tenant_id = { envVarName = "DT_AZURE_AD_TENANT_ID" }
          }
        }
      }

      config = {
        enabled = false
      }

      configMap = {
        enabled = false
      }

      service = {
        type = "ClusterIP"
        ports = {
          app = { port = var.service_port }
        }
      }

      containerPorts = {
        http = { port = var.service_port }
      }

      livenessProbe = {
        httpGet = {
          path = var.healthcheck_path
          port = var.service_port
        }
        initialDelaySeconds = 60
        periodSeconds       = 10
        failureThreshold    = 9
      }

      readinessProbe = {
        httpGet = {
          path = var.healthcheck_path
          port = var.service_port
        }
        initialDelaySeconds = 30
        periodSeconds       = 10
        failureThreshold    = 9
      }

      containerResources = {
        # Cluster admission policy forces limits.memory == requests.memory
        # (matches gknowledge/gmcp pattern). Set both to the same value or
        # the limit silently gets clamped to the request and the pod OOMKills
        # at the lower bound. 1Gi covers the bursty /api/metrics + /api/roadmap
        # Jira-fetch workload that pushed the previous 256Mi cap into a tight
        # OOMKill loop in prod.
        limits = {
          cpu    = "500m"
          memory = "1Gi"
        }
        requests = {
          cpu    = "250m"
          memory = "1Gi"
        }
      }

      # Pin to x86_64 nodes. The backend image is built single-arch amd64
      # (see Dockerfile.backend `FROM --platform=linux/amd64`), so scheduling
      # onto arm64 Graviton nodes causes `exec format error` at container
      # start. Remove once the image is published as a multi-arch manifest.
      nodeSelector = {
        "kubernetes.io/arch" = "amd64"
      }

      ingress = {
        enabled     = true
        path        = "/*"
        pathType    = "ImplementationSpecific"
        servicePort = var.service_port
        annotations = {
          "alb.ingress.kubernetes.io/scheme"                       = var.ingress_scheme
          "alb.ingress.kubernetes.io/group.name"                   = var.ingress_group
          "alb.ingress.kubernetes.io/target-type"                  = "ip"
          "alb.ingress.kubernetes.io/group.order"                  = "20"
          "alb.ingress.kubernetes.io/healthcheck-path"             = var.healthcheck_path
          "alb.ingress.kubernetes.io/healthcheck-interval-seconds" = "10"
        }
        hosts = [
          local.api_domain
        ]
      }
    })
  ]

  depends_on = [
    module.managed_secrets,
    module.managed_secrets_aad,
  ]
}
