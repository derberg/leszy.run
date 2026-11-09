"""A host run must see the keys in the repository's own .env.

On 2026-11-09 a host run read only enricher/.env, which had no
BRAVE_SEARCH_API_KEY, so every search fell back to SearXNG unnoticed.
"""
from enricher import config as cfg


def _clear(monkeypatch):
    for k in ("BRAVE_SEARCH_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        monkeypatch.delenv(k, raising=False)


def test_reads_brave_key_from_repo_root_env(tmp_path, monkeypatch):
    _clear(monkeypatch)
    monkeypatch.chdir(tmp_path)  # no enricher/.env in cwd
    root = tmp_path / "root.env"
    root.write_text("SUPABASE_URL=http://x\nSUPABASE_SERVICE_ROLE_KEY=k\nBRAVE_SEARCH_API_KEY=brave-root\n")
    assert cfg.load_config(enricher_env=tmp_path / "none.env", root_env=root).brave_api_key == "brave-root"


def test_environment_wins_over_root_env(tmp_path, monkeypatch):
    _clear(monkeypatch)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SUPABASE_URL", "http://x")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "k")
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "from-docker")
    root = tmp_path / "root.env"
    root.write_text("BRAVE_SEARCH_API_KEY=brave-root\n")
    assert cfg.load_config(enricher_env=tmp_path / "none.env", root_env=root).brave_api_key == "from-docker"


def test_missing_root_env_is_fine(tmp_path, monkeypatch):
    _clear(monkeypatch)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SUPABASE_URL", "http://x")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "k")
    assert cfg.load_config(enricher_env=tmp_path / "none.env", root_env=tmp_path / "nope.env").brave_api_key == ""


def test_enricher_env_fills_first(tmp_path, monkeypatch):
    _clear(monkeypatch)
    own = tmp_path / "own.env"
    own.write_text("SUPABASE_URL=http://x\nSUPABASE_SERVICE_ROLE_KEY=k\n")
    root = tmp_path / "root.env"
    root.write_text("SUPABASE_URL=http://other\nBRAVE_SEARCH_API_KEY=brave-root\n")
    c = cfg.load_config(enricher_env=own, root_env=root)
    assert c.supabase_url == "http://x"
    assert c.brave_api_key == "brave-root"


def test_default_points_at_repository_root():
    assert cfg.REPO_ROOT_ENV.parent.joinpath("enricher", "enricher", "config.py").is_file()
