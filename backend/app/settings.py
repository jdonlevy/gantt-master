from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "delivery-tracker"
    jira_base_url: str = "https://api.atlassian.com"
    jira_oauth_client_id: str = ""
    jira_oauth_client_secret: str = ""
    jira_oauth_redirect_uri: str = "http://localhost:8000/api/jira/callback"
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/delivery_tracker"
    cors_origins: str = "http://localhost:3000"
    session_secret: str = "change-me"
    ui_base_url: str = "http://localhost:3000"
    bootstrap_admins: str = ""

    # Azure AD / EntraID — primary authentication source.
    azure_ad_client_id: str = ""
    azure_ad_tenant_id: str = ""
    # Empty until the app registration exposes a user_impersonation scope.
    # When empty, the backend accepts Graph access tokens via unverified
    # decode (Microsoft doesn't publish signing keys for Graph tokens).
    azure_ad_api_scope: str = ""
    # Local-dev bypass: skip JWT signature verification entirely.
    dev_skip_jwt_verify: bool = False

    class Config:
        env_prefix = "DT_"

    @property
    def bootstrap_admin_emails(self) -> list[str]:
        return [item.strip().lower() for item in self.bootstrap_admins.split(",") if item.strip()]


settings = Settings()
