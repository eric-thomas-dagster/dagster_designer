"""fetch_manifest: conditional requests so TTL refreshes don't burn GitHub's unauthenticated rate limit."""

import asyncio

import httpx

from app.services import genie_service as g


def _install_client(monkeypatch, handler):
    transport = httpx.MockTransport(handler)
    real = httpx.AsyncClient
    monkeypatch.setattr(g.httpx, "AsyncClient", lambda *a, **k: real(*a, transport=transport, **{k_: v for k_, v in k.items() if k_ != "transport"}))


def _reset(monkeypatch, tmp_path):
    monkeypatch.setattr(g, "_DISK_CACHE_PATH", tmp_path / "m.json")
    monkeypatch.setitem(g._manifest_cache, "data", None)
    monkeypatch.setitem(g._manifest_cache, "fetched_at", 0.0)
    monkeypatch.setitem(g._manifest_cache, "etag", None)


def test_second_refresh_sends_if_none_match_and_keeps_data_on_304(monkeypatch, tmp_path):
    _reset(monkeypatch, tmp_path)
    seen = []

    def handler(request):
        seen.append(request.headers.get("if-none-match"))
        if request.headers.get("if-none-match") == '"v1"':
            return httpx.Response(304)
        return httpx.Response(200, json={"components": [{"id": "a"}]}, headers={"etag": '"v1"'})

    _install_client(monkeypatch, handler)
    first = asyncio.run(g.fetch_manifest())
    monkeypatch.setitem(g._manifest_cache, "fetched_at", 0.0)  # TTL expired
    second = asyncio.run(g.fetch_manifest())
    assert seen == [None, '"v1"']
    assert second == first == {"components": [{"id": "a"}]}
    assert g._manifest_cache["fetched_at"] > 0  # a 304 still resets the TTL


def test_a_changed_manifest_replaces_the_cache_and_etag(monkeypatch, tmp_path):
    _reset(monkeypatch, tmp_path)
    bodies = iter([({"components": [{"id": "a"}]}, '"v1"'), ({"components": [{"id": "b"}]}, '"v2"')])

    def handler(request):
        body, etag = next(bodies)
        return httpx.Response(200, json=body, headers={"etag": etag})

    _install_client(monkeypatch, handler)
    asyncio.run(g.fetch_manifest())
    monkeypatch.setitem(g._manifest_cache, "fetched_at", 0.0)
    assert asyncio.run(g.fetch_manifest()) == {"components": [{"id": "b"}]}
    assert g._manifest_cache["etag"] == '"v2"'


def test_disk_warmed_cache_without_an_etag_gets_a_full_fetch(monkeypatch, tmp_path):
    _reset(monkeypatch, tmp_path)
    (tmp_path / "m.json").write_text('{"components": [{"id": "stale"}]}')
    seen = []

    def handler(request):
        seen.append(request.headers.get("if-none-match"))
        return httpx.Response(200, json={"components": [{"id": "fresh"}]}, headers={"etag": '"x"'})

    _install_client(monkeypatch, handler)
    assert asyncio.run(g.fetch_manifest()) == {"components": [{"id": "fresh"}]}
    assert seen == [None]
