"""Minimal client for Dagster+'s hosted MCP server.

Dagster+ exposes live tool access (runs, run logs, assets, deployments,
alert policies, Issues, Insights metrics) over MCP at a region-specific
URL:
  • US: https://mcp.agent.dagster.cloud/mcp
  • EU: https://mcp.agent.eu.dagster.cloud/mcp

This is a hand-rolled client against the MCP "Streamable HTTP" transport
(JSON-RPC 2.0 over HTTP POST, response either a single JSON object or a
one-shot SSE stream) rather than the official `mcp` SDK -- the surface we
need (initialize, tools/list, tools/call) is small enough that pulling in
a new dependency for it isn't worth it, and it keeps this in the same
"thin httpx wrapper" style as dagster_plus_client.py.

Auth follows Dagster+'s documented raw-HTTP scheme: a user token as a
Bearer token, plus the org name in a separate header (there's no
per-deployment scoping at the connection level -- tools that need a
deployment take it as an argument instead).
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from .dagster_plus_client import _region_host_suffix

MCP_PROTOCOL_VERSION = "2025-06-18"


class DagsterPlusMcpError(RuntimeError):
    """Raised on transport failures, JSON-RPC errors, or tool-level errors."""


def _mcp_url(region: str | None) -> str:
    return f"https://mcp.agent.{_region_host_suffix(region)}/mcp"


def _clean_org(org: str) -> str:
    """Same trimming dagster_plus_client._graphql_url does -- users
    sometimes paste the full host instead of the bare subdomain."""
    o = (org or "").strip().replace("https://", "").replace("http://", "").split("/", 1)[0]
    for suffix in (".eu.dagster.cloud", ".dagster.cloud", ".dagster.plus"):
        if o.endswith(suffix):
            o = o.rsplit(suffix, 1)[0]
    return o


def _parse_rpc_response(resp: httpx.Response) -> dict[str, Any]:
    """The server may answer with a single JSON object OR a one-shot SSE
    stream carrying exactly one `data:` event with the JSON-RPC response
    (see MCP's Streamable HTTP transport spec). We don't need streaming
    tool progress here, so we just read the stream to completion and
    pull out that one event."""
    ctype = resp.headers.get("content-type", "")
    if "text/event-stream" in ctype:
        for raw_line in resp.text.splitlines():
            line = raw_line.strip()
            if line.startswith("data:"):
                payload = line[len("data:"):].strip()
                if payload:
                    return json.loads(payload)
        raise DagsterPlusMcpError("MCP server returned an SSE stream with no data event.")
    if not resp.content:
        return {}
    return resp.json()


class DagsterPlusMcpSession:
    """One MCP session: initialize, issue calls, done. Opened fresh per
    request rather than pooled/reused across requests -- Designer's usage
    pattern is "answer one chat turn, maybe call 1-3 tools", not a
    long-lived connection, so the extra round trip for `initialize` isn't
    worth the complexity of session lifecycle management.

    Usage:
        async with DagsterPlusMcpSession(org, token, region) as mcp:
            tools = await mcp.list_tools()
            result = await mcp.call_tool("list_runs", {"limit": 5})
    """

    def __init__(self, org: str, token: str, region: str | None):
        self.url = _mcp_url(region)
        self._base_headers = {
            "Authorization": f"Bearer {token}",
            # Case-sensitive on Dagster+'s side even though the org
            # subdomain itself is case-insensitive: `tools/list` doesn't
            # care (no org-specific proxying), but every real `tools/call`
            # 401s unless this is lowercase -- confirmed live against an
            # org stored as "Hooli": lowercased to "hooli" it works,
            # sent as-is it 401s, with the exact same token either way.
            "Dagster-Cloud-Organization": _clean_org(org).lower(),
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        self._session_id: str | None = None
        self._client: httpx.AsyncClient | None = None
        self._next_id = 1

    async def __aenter__(self) -> "DagsterPlusMcpSession":
        self._client = httpx.AsyncClient(timeout=30.0)
        try:
            await self._initialize()
        except Exception:
            await self._client.aclose()
            raise
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._client:
            await self._client.aclose()

    def _headers(self, *, versioned: bool = True) -> dict[str, str]:
        h = dict(self._base_headers)
        if self._session_id:
            h["Mcp-Session-Id"] = self._session_id
        if versioned:
            h["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION
        return h

    async def _initialize(self) -> None:
        assert self._client is not None
        try:
            resp = await self._client.post(
                self.url,
                headers=self._headers(versioned=False),
                json={
                    "jsonrpc": "2.0",
                    "id": 0,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": MCP_PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": {"name": "dagster-designer", "version": "1.0"},
                    },
                },
            )
        except httpx.HTTPError as e:
            raise DagsterPlusMcpError(f"Couldn't reach Dagster+ MCP server: {e}") from e
        if resp.status_code == 401 or resp.status_code == 403:
            raise DagsterPlusMcpError("Dagster+ rejected the token for MCP access.")
        if resp.status_code >= 400:
            raise DagsterPlusMcpError(f"MCP initialize failed: HTTP {resp.status_code}: {resp.text[:400]}")
        data = _parse_rpc_response(resp)
        if "error" in data:
            raise DagsterPlusMcpError(data["error"].get("message", "MCP initialize failed."))
        sid = resp.headers.get("Mcp-Session-Id") or resp.headers.get("mcp-session-id")
        if sid:
            self._session_id = sid
        # Required per the lifecycle spec -- a notification (no `id`),
        # server should 202 it. Non-fatal if the server ignores it.
        try:
            await self._client.post(
                self.url,
                headers=self._headers(),
                json={"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
            )
        except httpx.HTTPError:
            pass

    async def _call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        assert self._client is not None
        self._next_id += 1
        try:
            resp = await self._client.post(
                self.url,
                headers=self._headers(),
                json={"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params},
            )
        except httpx.HTTPError as e:
            raise DagsterPlusMcpError(f"Couldn't reach Dagster+ MCP server: {e}") from e
        if resp.status_code >= 400:
            raise DagsterPlusMcpError(f"MCP {method} failed: HTTP {resp.status_code}: {resp.text[:400]}")
        data = _parse_rpc_response(resp)
        if "error" in data:
            raise DagsterPlusMcpError(data["error"].get("message", f"MCP {method} failed."))
        return data.get("result") or {}

    async def list_tools(self) -> list[dict[str, Any]]:
        """Each tool: {name, description, inputSchema}."""
        result = await self._call("tools/list", {})
        return result.get("tools") or []

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        """Returns the tool's text output (MCP tool results are a list of
        content blocks; we join the text ones -- Dagster+'s tools are all
        data-lookup/action tools that reply in text/JSON-as-text, not
        images or other media)."""
        result = await self._call("tools/call", {"name": name, "arguments": arguments})
        if result.get("isError"):
            content = result.get("content") or []
            msg = next((c.get("text") for c in content if c.get("type") == "text"), None)
            raise DagsterPlusMcpError(msg or f"Tool '{name}' returned an error.")
        content = result.get("content") or []
        texts = [c.get("text", "") for c in content if c.get("type") == "text"]
        return "\n".join(t for t in texts if t) or json.dumps(result)
