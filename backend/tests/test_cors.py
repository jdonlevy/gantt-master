from app.main import build_cors_origins
from app.settings import settings


def test_build_cors_origins_includes_ui_base_url():
    original_cors = settings.cors_origins
    original_ui = settings.ui_base_url
    try:
        settings.cors_origins = "https://api.example.com"
        settings.ui_base_url = "https://ui.example.com/"

        origins = build_cors_origins()

        assert "https://api.example.com" in origins
        assert "https://ui.example.com" in origins
    finally:
        settings.cors_origins = original_cors
        settings.ui_base_url = original_ui


def test_build_cors_origins_defaults_to_localhost():
    original_cors = settings.cors_origins
    original_ui = settings.ui_base_url
    try:
        settings.cors_origins = ""
        settings.ui_base_url = ""

        origins = build_cors_origins()

        assert "http://localhost:3000" in origins
    finally:
        settings.cors_origins = original_cors
        settings.ui_base_url = original_ui
