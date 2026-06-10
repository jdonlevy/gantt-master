import pytest

from app.main import enforce_required_env


def test_enforce_required_env_skips_non_prod(monkeypatch):
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("DT_UI_BASE_URL", raising=False)
    monkeypatch.delenv("DT_CORS_ORIGINS", raising=False)
    enforce_required_env()


def test_enforce_required_env_requires_in_prod(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("DT_UI_BASE_URL", raising=False)
    monkeypatch.delenv("DT_CORS_ORIGINS", raising=False)
    with pytest.raises(RuntimeError) as exc:
        enforce_required_env()
    assert "DT_UI_BASE_URL" in str(exc.value)
    assert "DT_CORS_ORIGINS" in str(exc.value)


def test_enforce_required_env_passes_in_prod(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "prod")
    monkeypatch.setenv("DT_UI_BASE_URL", "https://delivery-tracker.example.com")
    monkeypatch.setenv("DT_CORS_ORIGINS", "https://delivery-tracker.example.com")
    enforce_required_env()
