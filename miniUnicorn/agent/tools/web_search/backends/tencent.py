"""腾讯搜索 API 后端。

腾讯云搜索服务,适合国内业务。
- 需要 secret_id + secret_key
- 环境变量: TENCENT_SEARCH_SECRET_ID / TENCENT_SEARCH_SECRET_KEY
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from urllib.parse import quote

from loguru import logger

from miniUnicorn.agent.tools.web_search.backends.base import (
    BackendResponse,
    SearchBackend,
    SearchResult,
)

_DEFAULT_BASE_URL = "https://tcb.tencentcloudapi.com"


class TencentBackend(SearchBackend):
    """腾讯搜索 API 后端。

    注:腾讯搜索 API 需要腾讯云账号 + 开通服务。
    配置优先级:config.web_search.backends.tencent.api_key 格式为 "secret_id:secret_key"
    或环境变量 TENCENT_SEARCH_SECRET_ID + TENCENT_SEARCH_SECRET_KEY
    """

    name = "tencent"
    requires_api_key = True
    env_var = "TENCENT_SEARCH_SECRET_ID"
    needs_proxy_in_cn = False

    async def search(self, query: str, count: int) -> BackendResponse:
        secret_id, secret_key = self._get_credentials()
        if not secret_id or not secret_key:
            return BackendResponse(
                backend=self.name,
                error="tencent: credentials not set (TENCENT_SEARCH_SECRET_ID + TENCENT_SEARCH_SECRET_KEY)",
            )

        try:
            async with self.make_client() as client:
                resp = await self._call_api(client, query, count, secret_id, secret_key)
                resp.raise_for_status()
                data = resp.json()
        except Exception as e:
            logger.debug("tencent search failed: {}", e)
            return BackendResponse(
                backend=self.name,
                error=f"tencent fetch failed: {type(e).__name__}: {e}",
            )

        results = self._parse(data, count)
        if not results:
            return BackendResponse(backend=self.name, error="tencent: no results in response")
        return BackendResponse(backend=self.name, results=results)

    def _get_credentials(self) -> tuple[str, str]:
        """获取腾讯云凭证。"""
        import os

        secret_id = os.environ.get("TENCENT_SEARCH_SECRET_ID", "")
        secret_key = os.environ.get("TENCENT_SEARCH_SECRET_KEY", "")
        # 支持 config.api_key = "secret_id:secret_key" 简化配置
        combined = self.get_api_key()
        if combined and ":" in combined:
            parts = combined.split(":", 1)
            secret_id = secret_id or parts[0]
            secret_key = parts[1]
        return secret_id, secret_key

    async def _call_api(self, client, query: str, count: int, secret_id: str, secret_key: str):
        """调用腾讯云 API(简化版,实际接入时按腾讯云搜索产品 API 调整)。

        这里使用腾讯云 API v3 签名规范。
        """
        service = "tcb"
        action = "DescribeSearchResult"
        version = "2018-06-08"
        timestamp = int(time.time())
        date = time.strftime("%Y-%m-%d", time.gmtime(timestamp))

        payload = json.dumps({
            "Query": query,
            "Limit": count,
        })

        # 腾讯云 API v3 签名
        credential_scope = f"{date}/{service}/tc3_request"
        canonical_request = (
            f"POST\n/\n\n"
            f"content-type:application/json; charset=utf-8\n"
            f"host:{_DEFAULT_BASE_URL.split('://')[1]}\n"
            f"x-tc-action:{action.lower()}\n\n"
            f"content-type;host;x-tc-action\n"
            f"{hashlib.sha256(payload.encode('utf-8')).hexdigest()}"
        )

        string_to_sign = (
            f"TC3-HMAC-SHA256\n{timestamp}\n{credential_scope}\n"
            f"{hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()}"
        )

        secret_date = hmac.new(("TC3" + secret_key).encode("utf-8"), date.encode("utf-8"), hashlib.sha256).digest()
        secret_service = hmac.new(secret_date, service.encode("utf-8"), hashlib.sha256).digest()
        secret_signing = hmac.new(secret_service, "tc3_request".encode("utf-8"), hashlib.sha256).digest()
        signature = hmac.new(secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

        authorization = (
            f"TC3-HMAC-SHA256 "
            f"Credential={secret_id}/{credential_scope}, "
            f"SignedHeaders=content-type;host;x-tc-action, "
            f"Signature={signature}"
        )

        return await client.post(
            _DEFAULT_BASE_URL,
            headers={
                "Authorization": authorization,
                "Content-Type": "application/json; charset=utf-8",
                "Host": _DEFAULT_BASE_URL.split("://")[1] if "://" in _DEFAULT_BASE_URL else _DEFAULT_BASE_URL,
                "X-TC-Action": action,
                "X-TC-Version": version,
                "X-TC-Timestamp": str(timestamp),
            },
            content=payload,
        )

    def _parse(self, data: dict, count: int) -> list[SearchResult]:
        """解析腾讯云搜索响应。"""
        # 响应结构因产品而异,这里给一个通用解析
        response = data.get("Response") or {}
        results_raw = response.get("Results") or response.get("Data") or []
        results: list[SearchResult] = []
        for item in results_raw[:count]:
            title = str(item.get("Title") or item.get("title") or "")
            url = str(item.get("Url") or item.get("url") or "")
            snippet = str(item.get("Summary") or item.get("Snippet") or item.get("Content") or "")
            if not title or not url:
                continue
            results.append(
                SearchResult(
                    title=title,
                    url=url,
                    snippet=snippet,
                    source_backend=self.name,
                )
            )
        return results
