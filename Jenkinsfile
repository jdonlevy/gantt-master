namespace = 'delivery-tracker'
workspace = 'delivery-tracker'
backendWorkspace = "${workspace}-backend"
frontendWorkspace = "${workspace}-frontend"

apps = [
    'delivery-tracker-ui',
    'delivery-tracker'
]

setup

node {
    ws {
        try {
            yarnDockerAndPromote([
                aws: [role: 'dev-delivery-tracker-releaser', account: 'YOUR_AWS_ACCOUNT_ID'],
                images: [
                    'your-org/delivery-tracker-ui': [
                        dockerfile: 'Dockerfile',
                        path: 'frontend'
                    ]
                ],
                registry: 'ghcr.io',
                registryCredentials: 'github-credentials',
                nodeTagVersion: '20',
                ecrAwsRole: 'dev-delivery-tracker-releaser',
                ecrCopyImages: [
                    'your-org/delivery-tracker-ui': 'dev/delivery-tracker/delivery-tracker-ui'
                ],
                promoteApps: [
                    apps: ['delivery-tracker-ui'],
                    namespace: namespace
                ]
            ])
        } finally {
            stage('UI Workspace Cleanup') {
                sh '''
                    echo "frontend/node_modules (before cleanWs):"
                    if [ -d frontend/node_modules ]; then
                        echo "exists: yes"
                        du -sh frontend/node_modules || true
                    else
                        echo "exists: no"
                    fi
                '''
                cleanWs()
                sh '''
                    echo "frontend/node_modules (after cleanWs):"
                    if [ -d frontend/node_modules ]; then
                        echo "exists: yes"
                        du -sh frontend/node_modules || true
                    else
                        echo "exists: no"
                    fi
                '''
            }
        }
    }
}

node {
    ws {
        try {
            cleanWs()
            checkout scm

            stage('Build Backend Images') {
                dockerImageECR([
                    images: [
                        'dev/delivery-tracker/delivery-tracker': [
                            dockerfile: 'Dockerfile.backend',
                            path: '.'
                        ]
                    ],
                    registry: 'YOUR_AWS_ACCOUNT_ID.dkr.ecr.YOUR_AWS_REGION.amazonaws.com',
                    aws: [
                        role: 'dev-delivery-tracker-releaser',
                        account: 'YOUR_AWS_ACCOUNT_ID'
                    ],
                    promoteApps: [
                        namespace: namespace,
                        apps: ['delivery-tracker']
                    ]
                ])
            }

            dir('terraform/backend') {
                terraformDeploy(environment: 'dev', namespace: namespace, workspace: backendWorkspace, review: false) {
                    stage("${environment} Plan (backend + infra)") {
                        plan()
                    }
                }
            }

            dir('terraform/frontend') {
                terraformDeploy(environment: 'dev', namespace: namespace, workspace: frontendWorkspace, review: false) {
                    stage("${environment} Plan (frontend)") {
                        plan()
                    }
                }
            }
        } finally {
            cleanWs()
        }
    }
}

if (env.BRANCH_NAME != 'main') {
    return
}

appVersions(namespace: namespace, apps: apps) {
    node {
        ws {
            try {
                cleanWs()
                checkout scm

                dir('terraform/backend') {
                    terraformDeploy(environment: 'dev', namespace: namespace, workspace: backendWorkspace, review: false) {
                        stage("${environment} Apply (backend + infra)") {
                            apply()
                        }
                    }
                }

                dir('terraform/frontend') {
                    terraformDeploy(environment: 'dev', namespace: namespace, workspace: frontendWorkspace, review: false) {
                        stage("${environment} Apply (frontend)") {
                            apply()
                        }
                    }
                }

                cleanWs()
                checkout scm

                dir('terraform/backend') {
                    terraformDeploy(environment: 'prod', namespace: namespace, workspace: backendWorkspace) {
                        stage("${environment} Plan (backend + infra)") {
                            plan()
                        }
                    }
                }

                dir('terraform/frontend') {
                    terraformDeploy(environment: 'prod', namespace: namespace, workspace: frontendWorkspace) {
                        stage("${environment} Plan (frontend)") {
                            plan()
                        }
                    }
                }
            } finally {
                cleanWs()
            }
        }
    }

    timeout(7200) {
        input 'Continue to Prod?'
    }

    promoteApps('prod')

    node {
        ws {
            try {
                cleanWs()
                checkout scm

                dir('terraform/backend') {
                    terraformDeploy(environment: 'prod', namespace: namespace, workspace: backendWorkspace) {
                        stage("${environment} Plan (backend + infra)") {
                            plan("${environment}.backend.tfplan")
                        }
                        stage("${environment} Apply (backend + infra)") {
                            apply("${environment}.backend.tfplan")
                        }
                    }
                }

                dir('terraform/frontend') {
                    terraformDeploy(environment: 'prod', namespace: namespace, workspace: frontendWorkspace) {
                        stage("${environment} Plan (frontend)") {
                            plan("${environment}.frontend.tfplan")
                        }
                        stage("${environment} Apply (frontend)") {
                            apply("${environment}.frontend.tfplan")
                        }
                    }
                }
            } finally {
                cleanWs()
            }
        }
    }
}
