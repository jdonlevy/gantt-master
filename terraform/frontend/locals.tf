locals {
  ui_name = "delivery-tracker-ui"
  api_name = "delivery-tracker"
  ui_resource_name = "${local.ui_name}-v1-${var.resource_suffix}"

  ui_domain = "${local.ui_name}-${var.namespace}.${data.aws_ssm_parameter.dns_zone_name.insecure_value}"

  backend_domain = "${local.api_name}-${var.namespace}.${data.aws_ssm_parameter.dns_zone_name.insecure_value}"

  # Node architecture the image was built for. Referenced from both the
  # deployment annotation and the nodeSelector so the two can't drift when we
  # switch to a multi-arch image.
  node_arch = "amd64"
}
