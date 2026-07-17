"""Network security utilities — SSRF protection and internal URL detection.

The ``create_ssrf_safe_client`` factory and ``_SSRFSafeRequestHook`` borrow
the design of Reasonix's ``ssrfGuardedTransport``: outbound HTTP requests are
intercepted just before dial so IP-literal targets can be blocked at the
transport layer. Hostname targets are validated pre-flight by
``validate_url_target`` in the redirect-safe fetch wrappers (covering both
initial requests and any explicit redirects). When a proxy is configured,
hostnames are forwarded to the proxy for resolution (matching Reasonix's
GFW-friendly behaviour); IP-literal targets are still checked client-side.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from contextlib import suppress
from typing import Any
from urllib.parse import urlparse

import httpx

_BLOCKED_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),   # carrier-grade NAT
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),   # link-local / cloud metadata
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),          # unique local
    ipaddress.ip_network("fe80::/10"),         # link-local v6
]

# Networks that are ALWAYS blocked, even if the operator adds them to the
# SSRF whitelist via ``configure_ssrf_whitelist``.  These cover cloud metadata
# endpoints (169.254.0.0/16 — AWS/GCP/Azure IMDS) and loopback (127.0.0.0/8,
# ::1) which must never be reachable from a server-side fetch context.
_HARD_BLOCKED_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),   # link-local / cloud metadata
    ipaddress.ip_network("::1/128"),
]

_URL_RE = re.compile(r"https?://[^\s\"'`;|<>]+", re.IGNORECASE)

_allowed_networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []


def configure_ssrf_whitelist(cidrs: list[str]) -> None:
    """Allow specific CIDR ranges to bypass SSRF blocking (e.g. Tailscale's 100.64.0.0/10)."""
    global _allowed_networks
    nets = []
    for cidr in cidrs:
        with suppress(ValueError):
            nets.append(ipaddress.ip_network(cidr, strict=False))
    _allowed_networks = nets


def _normalize_addr(
    addr: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    """Normalize IPv6-mapped IPv4 addresses to their IPv4 form.

    ``::ffff:127.0.0.1`` is semantically identical to ``127.0.0.1`` but
    Python's ipaddress treats it as an IPv6Address that matches neither
    ``127.0.0.0/8`` nor ``::1/128``.  Converting it to IPv4 ensures
    blocklist/allowlist checks work correctly.
    """
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        return addr.ipv4_mapped
    return addr


def _is_private(addr: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    normalized = _normalize_addr(addr)
    # Hard-blocked networks (cloud metadata, loopback) can never be bypassed
    # by the SSRF whitelist — this prevents an operator mistake from exposing
    # IMDS endpoints to server-side fetches.
    if any(normalized in net for net in _HARD_BLOCKED_NETWORKS):
        return True
    if _allowed_networks and any(normalized in net for net in _allowed_networks):
        return False
    return any(normalized in net for net in _BLOCKED_NETWORKS)


def validate_url_target(url: str, *, allow_loopback: bool = False) -> tuple[bool, str]:
    """Validate a URL is safe to fetch: scheme, hostname, and resolved IPs.

    ``allow_loopback`` is intentionally narrow: it only permits literal
    loopback hosts (localhost, 127.0.0.0/8, ::1) when every resolved address is
    loopback. It does not allow RFC1918, link-local, metadata, or public DNS
    names that happen to resolve to loopback.

    Returns (ok, error_message).  When ok is True, error_message is empty.
    """
    try:
        p = urlparse(url)
    except Exception as e:
        return False, str(e)

    if p.scheme not in ("http", "https"):
        return False, f"Only http/https allowed, got '{p.scheme or 'none'}'"
    if not p.netloc:
        return False, "Missing domain"

    hostname = p.hostname
    if not hostname:
        return False, "Missing hostname"

    try:
        infos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror:
        return False, f"Cannot resolve hostname: {hostname}"

    addrs: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        addrs.append(addr)
    if allow_loopback and _is_allowed_loopback_target(hostname, addrs):
        return True, ""
    for addr in addrs:
        if _is_private(addr):
            return False, f"Blocked: {hostname} resolves to private/internal address {addr}"

    return True, ""


def validate_resolved_url(url: str) -> tuple[bool, str]:
    """Validate an already-fetched URL (e.g. after redirect). Only checks the IP, skips DNS."""
    try:
        p = urlparse(url)
    except Exception:
        return True, ""

    hostname = p.hostname
    if not hostname:
        return True, ""

    try:
        addr = ipaddress.ip_address(hostname)
        if _is_private(addr):
            return False, f"Redirect target is a private address: {addr}"
    except ValueError:
        # hostname is a domain name, resolve it
        try:
            infos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        except socket.gaierror:
            return True, ""
        for info in infos:
            try:
                addr = ipaddress.ip_address(info[4][0])
            except ValueError:
                continue
            if _is_private(addr):
                return False, f"Redirect target {hostname} resolves to private address {addr}"

    return True, ""


def contains_internal_url(command: str, *, allow_loopback: bool = False) -> bool:
    """Return True if the command string contains a URL targeting an internal/private address."""
    for m in _URL_RE.finditer(command):
        url = m.group(0)
        ok, _ = validate_url_target(url, allow_loopback=allow_loopback)
        if not ok:
            return True
    return False


def _is_allowed_loopback_target(
    hostname: str,
    addrs: list[ipaddress.IPv4Address | ipaddress.IPv6Address],
) -> bool:
    if not addrs or not all(_normalize_addr(addr).is_loopback for addr in addrs):
        return False
    normalized = hostname.rstrip(".").lower()
    if normalized == "localhost":
        return True
    with suppress(ValueError):
        return ipaddress.ip_address(hostname).is_loopback
    return False


def _ssrf_request_hook(proxy: str | None) -> Any:
    """Build an httpx request event hook that blocks SSRF at dial time.

    Defence-in-depth complement to the pre-flight ``validate_url_target``
    call in ``_get_with_safe_redirects`` / ``_stream_with_safe_redirects``.

    - For IP-literal hosts: always checked against the private/internal
      blocklist (this is the path that catches a re-bound dial even when
      a proxy is configured).
    - For hostname hosts without a proxy: re-validated via
      ``validate_url_target`` so any redirect followed by httpx internally
      is also covered.
    - For hostname hosts with a proxy: the proxy resolves DNS (matches
      Reasonix's behaviour for GFW-friendly operation); we skip local
      resolution to avoid leaking the queried hostname through a
      side-channel DNS lookup.
    """

    async def _hook(request: httpx.Request) -> None:
        host = request.url.host
        if not host:
            return
        # IP-literal hosts are checked directly regardless of proxy.
        try:
            addr = ipaddress.ip_address(host)
        except ValueError:
            if not proxy:
                ok, err = validate_url_target(str(request.url))
                if not ok:
                    raise httpx.ConnectError(
                        f"SSRF blocked: {err}",
                        request=request,
                    )
            return
        if _is_private(addr):
            raise httpx.ConnectError(
                f"SSRF blocked: target {host} is a private/internal address",
                request=request,
            )

    return _hook


def create_ssrf_safe_client(
    *,
    proxy: str | None = None,
    timeout: float | httpx.Timeout = 10.0,
    **kwargs: Any,
) -> httpx.AsyncClient:
    """Create an httpx.AsyncClient that blocks SSRF attacks on every request.

    Installs a request event hook (Reasonix ``ssrfGuardedTransport`` style)
    that re-validates each outbound request's target IP just before dial.
    This catches redirect-based SSRF that httpx might follow internally, on
    top of the explicit redirect-safe wrappers used by WebFetchTool.

    When ``proxy`` is set, hostnames are forwarded to the proxy for DNS
    resolution (no local lookup, GFW-friendly) but IP-literal hosts are
    still blocked client-side — matching Reasonix's IP-literal check path.
    """
    hook = _ssrf_request_hook(proxy)
    return httpx.AsyncClient(
        proxy=proxy,
        timeout=timeout,
        event_hooks={"request": [hook]},
        **kwargs,
    )
