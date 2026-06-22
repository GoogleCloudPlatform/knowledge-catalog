"""
API Source - 从 HTTP/API 接口拉取文件并生成 OKF 知识库

支持的 API 类型：
  - REST API（返回 JSON，含文件 URL 列表）
  - 直接文件 URL 列表
  - 飞书/钉钉/企业微信等云文档 API（需自行适配认证）

用法：
  reference-agent localfile <url-or-api> --pattern "api" -o ./bundle
  # 或通过 enrich
  python -m reference_agent enrich --source api ...

设计原则：不改原码，仅继承 Source 抽象基类。
"""

from __future__ import annotations

import json
import os
import re
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any
from tempfile import mkdtemp

from reference_agent.sources.base import ConceptRef, Source


# 文件扩展名 → 概念类型（复用 localfile 的映射）
_FILE_TYPE_MAP = {
    ".md": "Document",
    ".markdown": "Document",
    ".txt": "Document",
    ".pdf": "PDF Document",
    ".docx": "Word Document",
    ".xlsx": "Excel Spreadsheet",
    ".pptx": "PowerPoint Presentation",
    ".py": "Python Module",
    ".ts": "TypeScript Module",
    ".js": "JavaScript Module",
    ".json": "Config File",
    ".yaml": "Config File",
    ".yml": "Config File",
    ".html": "HTML Document",
    ".csv": "Data File",
}


def _get_file_type(url: str) -> str:
    """从 URL 路径推断文件类型"""
    path = url.split("?")[0].split("#")[0]
    suffix = Path(path).suffix.lower()
    return _FILE_TYPE_MAP.get(suffix, "File")


def _sanitize_name(url: str) -> str:
    """从 URL 生成合法的 concept ID 段"""
    path = url.split("?")[0].split("#")[0]
    name = Path(path).stem
    # 替换非法字符
    name = re.sub(r"[^\w.\-]", "_", name)
    return name or "remote_file"


class ApiSource(Source):
    """从 HTTP API / URL 列表拉取文件的 Source

    三种模式：
    1. 单文件 URL：直接下载
       ApiSource(urls=["https://example.com/doc.pdf"])
    2. API 端点：返回 JSON，含文件 URL 列表
       ApiSource(api_endpoint="https://api.example.com/files",
                 api_url_field="download_url")
    3. 文件 URL 列表文件：每行一个 URL
       ApiSource(url_file="urls.txt")
    """

    name = "api"

    def __init__(
        self,
        urls: list[str] | None = None,
        api_endpoint: str | None = None,
        api_url_field: str = "url",
        api_headers: dict[str, str] | None = None,
        url_file: str | None = None,
        auth_token: str | None = None,
        download_dir: str | None = None,
    ):
        self._urls: list[str] = list(urls or [])
        self.api_endpoint = api_endpoint
        self.api_url_field = api_url_field
        self.api_headers = api_headers or {}
        self.auth_token = auth_token or os.environ.get("API_AUTH_TOKEN")
        self.download_dir = Path(download_dir or mkdtemp(prefix="okf_api_"))
        self.download_dir.mkdir(parents=True, exist_ok=True)
        self._concepts_cache: list[ConceptRef] | None = None

        # 从 URL 列表文件加载
        if url_file:
            text = Path(url_file).read_text(encoding="utf-8")
            for line in text.splitlines():
                line = line.split("#", 1)[0].strip()
                if line:
                    self._urls.append(line)

    def _fetch_urls_from_api(self) -> list[str]:
        """从 API 端点获取文件 URL 列表"""
        if not self.api_endpoint:
            return []

        req = urllib.request.Request(self.api_endpoint)
        for k, v in self.api_headers.items():
            req.add_header(k, v)
        if self.auth_token:
            req.add_header("Authorization", f"Bearer {self.auth_token}")

        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        # 支持两种 JSON 结构：
        # 1. {"items": [{"url": "...", "name": "..."}, ...]}
        # 2. ["url1", "url2", ...]
        if isinstance(data, list):
            return [u for u in data if isinstance(u, str)]

        items = data.get("items") or data.get("data") or data.get("files") or []
        urls = []
        for item in items:
            if isinstance(item, str):
                urls.append(item)
            elif isinstance(item, dict):
                url = item.get(self.api_url_field) or item.get("url") or item.get("download_url")
                if url:
                    urls.append(url)
        return urls

    def _download(self, url: str) -> Path:
        """下载文件到本地临时目录"""
        name = _sanitize_name(url)
        ext = Path(url.split("?")[0]).suffix or ".txt"
        local_path = self.download_dir / f"{name}{ext}"

        if local_path.exists():
            return local_path

        req = urllib.request.Request(url)
        if self.auth_token:
            req.add_header("Authorization", f"Bearer {self.auth_token}")

        with urllib.request.urlopen(req) as resp:
            local_path.write_bytes(resp.read())
        return local_path

    def _get_all_urls(self) -> list[str]:
        """获取所有要处理的文件 URL"""
        urls = list(self._urls)
        if self.api_endpoint:
            urls.extend(self._fetch_urls_from_api())
        # 去重保序
        seen: set[str] = set()
        unique = []
        for u in urls:
            if u not in seen:
                seen.add(u)
                unique.append(u)
        return unique

    def list_concepts(self) -> list[ConceptRef]:
        if self._concepts_cache is not None:
            return self._concepts_cache

        concepts: list[ConceptRef] = []
        for url in self._get_all_urls():
            name = _sanitize_name(url)
            concept_type = _get_file_type(url)
            concepts.append(ConceptRef(
                id=(name,),
                type=concept_type,
                resource=url,
                hint={
                    "url": url,
                    "file_name": name + (Path(url.split("?")[0]).suffix or ".txt"),
                },
            ))

        self._concepts_cache = concepts
        return concepts

    def read_concept(self, ref: ConceptRef) -> dict[str, Any]:
        url = ref.hint.get("url") or ref.resource or ""
        if not url:
            raise ValueError(f"No URL for concept: {ref.id_str}")

        local_path = self._download(url)

        # 读取内容（复用 localfile 的读取逻辑）
        from reference_agent.sources.localfile import LocalFileSource
        temp_source = LocalFileSource(path=str(self.download_dir))
        temp_ref = temp_source.find((local_path.stem,))
        if temp_ref is None:
            # 文件可能刚下载，清除缓存重试
            temp_source._concepts_cache = None
            temp_ref = temp_source.find((local_path.stem,))

        if temp_ref:
            data = temp_source.read_concept(temp_ref)
            data["source_url"] = url
            return data

        # 回退：直接读取文本
        try:
            content = local_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            content = f"[Binary file from {url}]"

        return {
            "name": ref.id_str,
            "type": ref.type,
            "file_name": local_path.name,
            "file_path": str(local_path),
            "source_url": url,
            "content": content,
            "size_bytes": local_path.stat().st_size,
        }
