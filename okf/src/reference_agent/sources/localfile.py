"""
Local File Source - 从本地文件（PDF/Word/TXT/Markdown/代码）提取元数据

支持文件类型：
  - .md / .markdown    → Markdown 文件
  - .txt               → 纯文本文件
  - .pdf               → PDF 文件（需要 pdfplumber）
  - .docx              → Word 文档（需要 python-docx）
  - .py / .ts / .js    → 代码文件
  - .json / .yaml      → 配置文件

用法：
  python -m reference_agent enrich \
    --source localfile \
    --local-path /path/to/docs \
    --out ./my-bundle \
    --no-web
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from reference_agent.sources.base import ConceptRef, Source


# 文件类型 → 概念类型映射
_FILE_TYPE_MAP = {
    ".md": "Document",
    ".markdown": "Document",
    ".txt": "Document",
    ".pdf": "PDF Document",
    ".docx": "Word Document",
    ".xlsx": "Excel Spreadsheet",
    ".xls": "Excel Spreadsheet",
    ".pptx": "PowerPoint Presentation",
    ".ppt": "PowerPoint Presentation",
    ".py": "Python Module",
    ".ts": "TypeScript Module",
    ".js": "JavaScript Module",
    ".json": "Config File",
    ".yaml": "Config File",
    ".yml": "Config File",
    ".html": "HTML Document",
    ".csv": "Data File",
}

# 忽略的目录
_IGNORE_DIRS = {
    ".git", ".venv", "node_modules", "__pycache__",
    ".pytest_cache", "dist", "build", ".idea", ".vscode",
    "okf-bundle",
}


class LocalFileSource(Source):
    """从本地文件系统提取元数据的数据源"""

    name = "localfile"

    def __init__(
        self,
        path: str,
        pattern: str = "**/*",
        recursive: bool = True,
        max_file_size: int = 10 * 1024 * 1024,  # 10MB
    ):
        self.root = Path(path).resolve()
        if not self.root.exists():
            raise ValueError(f"Path does not exist: {self.root}")
        self.pattern = pattern
        self.recursive = recursive
        self.max_file_size = max_file_size
        self._concepts_cache: list[ConceptRef] | None = None

    def _should_ignore(self, path: Path) -> bool:
        """检查是否应该忽略该路径"""
        for part in path.parts:
            if part in _IGNORE_DIRS:
                return True
        return False

    def _get_concept_type(self, file_path: Path) -> str:
        """根据文件扩展名获取概念类型"""
        suffix = file_path.suffix.lower()
        return _FILE_TYPE_MAP.get(suffix, "File")

    def _file_to_concept_id(self, file_path: Path) -> tuple[str, ...]:
        """将文件路径转换为概念 ID

        示例：
          /docs/api/knowledge.md → ("docs", "api", "knowledge")
          /src/index.ts → ("src", "index")
        """
        try:
            rel = file_path.relative_to(self.root)
        except ValueError:
            rel = file_path
        # 去掉扩展名，分割路径
        parts = rel.with_suffix("").parts
        # 过滤无效字符
        valid_parts = tuple(
            p.replace(" ", "_").replace("-", "_")
            for p in parts
            if p and p != "."
        )
        return valid_parts if valid_parts else ("root", file_path.stem)

    def _read_markdown(self, path: Path) -> str:
        """读取 Markdown 文件"""
        return path.read_text(encoding="utf-8")

    def _read_text(self, path: Path) -> str:
        """读取纯文本文件"""
        try:
            return path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return path.read_text(encoding="gbk", errors="replace")

    def _read_pdf(self, path: Path) -> str:
        """读取 PDF 文件（需要 pdfplumber）"""
        try:
            import pdfplumber
        except ImportError:
            return f"[PDF file: {path.name} - install pdfplumber to extract text]"

        # Silence pdfplumber's noisy "Could not get FontBBox" warnings.
        import logging
        logging.getLogger("pdfminer").setLevel(logging.ERROR)

        text_parts = []
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                text_parts.append(page.extract_text() or "")
        return "\n\n".join(text_parts)

    def _read_docx(self, path: Path) -> str:
        """读取 Word 文档（需要 python-docx）"""
        try:
            from docx import Document
        except ImportError:
            return f"[DOCX file: {path.name} - install python-docx to extract text]"

        doc = Document(path)
        return "\n\n".join(para.text for para in doc.paragraphs if para.text.strip())

    def _read_excel(self, path: Path) -> str:
        """读取 Excel 文件（需要 openpyxl + pandas）"""
        try:
            import pandas as pd
        except ImportError:
            return f"[XLSX file: {path.name} - install pandas openpyxl to extract text]"

        # 读取所有 sheet
        xl = pd.ExcelFile(path)
        parts = []
        for sheet_name in xl.sheet_names:
            df = pd.read_excel(path, sheet_name=sheet_name, nrows=50)  # 限制 50 行
            parts.append(f"## Sheet: {sheet_name}\n\n{df.to_markdown(index=False)}")
        return "\n\n".join(parts)

    def _read_pptx(self, path: Path) -> str:
        """读取 PowerPoint 文件（需要 python-pptx）"""
        try:
            from pptx import Presentation
        except ImportError:
            return f"[PPTX file: {path.name} - install python-pptx to extract text]"

        prs = Presentation(path)
        parts = []
        for i, slide in enumerate(prs.slides, 1):
            slide_texts = []
            for shape in slide.shapes:
                if hasattr(shape, "text") and shape.text.strip():
                    slide_texts.append(shape.text.strip())
            if slide_texts:
                parts.append(f"## Slide {i}\n\n" + "\n\n".join(slide_texts))
        return "\n\n".join(parts) if parts else "[Empty presentation]"

    def _read_code(self, path: Path) -> str:
        """读取代码文件"""
        content = self._read_text(path)
        # 限制长度，避免超过 LLM token 限制
        max_chars = 8000
        if len(content) > max_chars:
            content = content[:max_chars] + f"\n\n... [truncated, {len(content)} chars total]"
        return content

    def _read_json(self, path: Path) -> str:
        """读取 JSON 文件"""
        return self._read_text(path)

    def list_concepts(self) -> list[ConceptRef]:
        """列出所有本地文件作为概念"""
        if self._concepts_cache is not None:
            return self._concepts_cache

        concepts: list[ConceptRef] = []
        supported_extensions = set(_FILE_TYPE_MAP.keys())

        # 遍历文件
        if self.recursive:
            files = self.root.rglob(self.pattern)
        else:
            files = self.root.glob(self.pattern)

        for file_path in files:
            # 跳过目录
            if not file_path.is_file():
                continue
            # 跳过忽略目录
            if self._should_ignore(file_path):
                continue
            # 跳过不支持的文件类型
            if file_path.suffix.lower() not in supported_extensions:
                continue
            # 跳过过大文件
            if file_path.stat().st_size > self.max_file_size:
                continue

            concept_id = self._file_to_concept_id(file_path)
            concept_type = self._get_concept_type(file_path)

            concepts.append(ConceptRef(
                id=concept_id,
                type=concept_type,
                resource=str(file_path),
                hint={
                    "file_path": str(file_path),
                    "file_name": file_path.name,
                    "file_ext": file_path.suffix,
                    "file_size": file_path.stat().st_size,
                },
            ))

        self._concepts_cache = concepts
        return concepts

    def read_concept(self, ref: ConceptRef) -> dict[str, Any]:
        """读取单个文件的原始数据"""
        file_path = Path(ref.hint.get("file_path", ref.resource or ""))
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        # 根据文件类型读取内容
        suffix = file_path.suffix.lower()
        if suffix in (".md", ".markdown"):
            content = self._read_markdown(file_path)
        elif suffix == ".txt":
            content = self._read_text(file_path)
        elif suffix == ".pdf":
            content = self._read_pdf(file_path)
        elif suffix == ".docx":
            content = self._read_docx(file_path)
        elif suffix in (".xlsx", ".xls"):
            content = self._read_excel(file_path)
        elif suffix in (".pptx", ".ppt"):
            content = self._read_pptx(file_path)
        elif suffix in (".py", ".ts", ".js", ".html"):
            content = self._read_code(file_path)
        elif suffix in (".json", ".yaml", ".yml"):
            content = self._read_json(file_path)
        else:
            content = self._read_text(file_path)

        return {
            "name": ref.id_str,
            "type": ref.type,
            "file_name": file_path.name,
            "file_path": str(file_path),
            "file_ext": file_path.suffix,
            "content": content,
            "size_bytes": file_path.stat().st_size,
        }

    def sample_rows(self, ref: ConceptRef, n: int = 5) -> list[dict[str, Any]] | None:
        """对 CSV/JSON 文件采样前 n 行"""
        file_path = Path(ref.hint.get("file_path", ""))
        if not file_path.exists():
            return None

        suffix = file_path.suffix.lower()
        if suffix == ".csv":
            import csv
            with open(file_path, encoding="utf-8") as f:
                reader = csv.DictReader(f)
                return [row for _, row in zip(range(n), reader)]
        elif suffix == ".json":
            import json
            try:
                data = json.loads(file_path.read_text(encoding="utf-8"))
                if isinstance(data, list):
                    return data[:n]
                return [data]
            except json.JSONDecodeError:
                return None
        return None
