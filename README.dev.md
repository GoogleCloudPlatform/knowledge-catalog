# 开发说明 · 功能扩展

> 本文档记录在 [Knowledge Catalog](https://github.com/GoogleCloudPlatform/knowledge-catalog) 基础上所做的二次开发与功能扩展。

---

## 一、概览

本扩展在不破坏原有功能的前提下，为 OKF 参考智能体（reference-agent）新增了**本地文件知识库生成**能力，并完善了**中文本地化**支持。所有改动向后兼容，原有 `enrich`、`visualize` 命令不受影响。

### 扩展内容速览

| 模块             | 说明                                                      |
|------------------|----------------------------------------------------------|
| `localfile` 子命令 | 从本地文件（PDF/Word/Excel/PPT/Markdown/代码）生成 OKF 知识包 |
| 中文文件名支持    | concept ID 验证放宽，支持 Unicode（中文/日文等）文件名         |
| 语言自动匹配      | LLM 自动检测源内容语言，用相同语言生成 OKF 文档               |
| 全局命令安装      | `reference-agent` 可全局安装，任何目录直接调用                |
| 中文文档          | SPEC 规范、各模块 README 的完整中文翻译                      |

---

## 二、新增 `localfile` 子命令

### 背景

原项目的 `enrich` 命令主要面向 BigQuery 数据源，命令较长：

```bash
python3 -m reference_agent enrich \
  --source localfile \
  --local-path /path/to/docs \
  --local-pattern "**/*.pdf" \
  --out ./bundle \
  --no-web \
  --model gemini-flash-latest
```

### 实现

新增 `localfile` 专用子命令，作为 `enrich --source localfile --no-web` 的快捷方式。

**修改文件：**

| 文件                    | 改动                                                          |
|------------------------|--------------------------------------------------------------|
| `okf/src/reference_agent/cli.py` | 新增 `localfile` subparser + `main()` 处理分支             |
| `okf/src/reference_agent/sources/localfile.py` | 新增 `LocalFileSource` 类（已有，本次为微调）   |
| `okf/pyproject.toml`    | 新增 `[project.optional-dependencies] localfile` 依赖组       |

**关键设计：**

- `path` 为可选位置参数，默认当前目录 `.`
- 自动跳过 Web 轮（`--no-web`），本地文件无需网页爬取
- 默认输出到 `./okf-bundle`
- `_IGNORE_DIRS` 新增 `"okf-bundle"`，防止递归扫描把生成的 `.md` 当源文件

### 用法

```bash
# 最简形式：扫描当前目录，输出到 ./okf-bundle/
cd /path/to/docs
reference-agent localfile

# 指定文件类型
reference-agent localfile --pattern "**/*.pdf"

# 指定源目录和输出目录
reference-agent localfile /path/to/docs --pattern "**/*.pdf" -o ./my-bundle

# 仅处理特定概念
reference-agent localfile /path/to/docs --concept "ERP_WIKI"
```

### 参数说明

| 参数               | 默认值                | 说明                                          |
|--------------------|----------------------|-----------------------------------------------|
| `path`             | `.`（当前目录）       | 要扫描的本地目录（位置参数，可选）              |
| `--pattern`        | `**/*`               | 文件匹配模式，如 `**/*.pdf`、`**/*.{md,txt}`   |
| `-o / --out`       | `./okf-bundle`       | 输出目录                                       |
| `--model`          | `gemini-flash-latest`| Gemini 模型 ID                                |
| `--no-recursive`   | *(关闭)*             | 禁用递归扫描                                   |
| `--concept`        | *(全部)*             | 仅处理指定概念 ID（可重复）                     |
| `-v / --verbose`   | *(关闭)*             | 详细日志输出                                   |

### 支持的文件类型

> 原项目仅支持 BigQuery 数据源，不支持任何本地文件格式。`LocalFileSource` 类和 `_FILE_TYPE_MAP` 映射表均为全新实现。其中 **文档格式（PDF/Word/Excel/PPT）需要额外解析库**，**基础文本格式（Markdown/TXT/代码/配置/HTML/CSV）使用 Python 内置能力直接读取**。

#### 新增文档格式（需安装 `[localfile]` 可选依赖）

| 扩展名                        | 概念类型               | 解析方式                          | 新增 |
|-------------------------------|------------------------|-----------------------------------|------|
| `.pdf`                        | PDF Document           | pdfplumber 提取文本               | ✅   |
| `.docx`                       | Word Document          | python-docx 提取段落              | ✅   |
| `.xlsx` / `.xls`              | Excel Spreadsheet      | pandas + openpyxl，限 50 行       | ✅   |
| `.pptx` / `.ppt`              | PowerPoint Presentation| python-pptx 提取幻灯片文本         | ✅   |

#### 基础文本格式（内置支持，无需额外依赖）

| 扩展名                        | 概念类型               | 解析方式                          |
|-------------------------------|------------------------|-----------------------------------|
| `.md` / `.markdown`           | Document               | 直接读取 UTF-8                    |
| `.txt`                        | Document               | UTF-8，回退 GBK                   |
| `.py`                         | Python Module          | 读取，超 8000 字符截断             |
| `.ts`                         | TypeScript Module      | 读取，超 8000 字符截断             |
| `.js`                         | JavaScript Module      | 读取，超 8000 字符截断             |
| `.json`                       | Config File            | 直接读取                          |
| `.yaml` / `.yml`              | Config File            | 直接读取                          |
| `.html`                       | HTML Document          | 读取，超 8000 字符截断             |
| `.csv`                        | Data File              | 支持采样前 5 行                    |

**解析依赖（`[localfile]` 可选依赖组，仅文档格式需要）：**

| 依赖            | 用途                      |
|-----------------|--------------------------|
| `pdfplumber`    | PDF 文本提取              |
| `python-docx`   | Word 文档段落提取          |
| `openpyxl`      | Excel 读取（配合 pandas）  |
| `python-pptx`   | PowerPoint 幻灯片提取      |

---

## 三、中文文件名支持

### 问题

文件名含中文（如 `Karpathy LLM 编程行为.pdf`）时，生成的 concept ID `Karpathy_LLM_编程行为` 无法通过 `paths.py` 的正则校验：

```python
# 原正则只允许 ASCII
_SEGMENT_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.\-]*")
# → ValueError: Invalid concept id segment: 'Karpathy_LLM_编程行为'
```

### 修复

**文件：** `okf/src/reference_agent/bundle/paths.py`

```python
# 放宽为 Unicode \w，支持中文等多语言文件名
_SEGMENT_RE = re.compile(r"\w[\w.\-]*")
```

`\w` 在 Python 3 的 `str` 模式下匹配 `[A-Za-z0-9_]` 加所有 Unicode 字母数字字符（中文、日文、韩文等）。

---

## 四、语言自动匹配

### 问题

生成的 OKF 文档默认用英文，即使源文件是中文内容。原因：prompt 全英文，未指示 LLM 匹配源语言。

### 修复方案（prompt-only，零代码改动）

**文件：** `okf/src/reference_agent/prompts/reference_instruction.md`

新增 `## Language` 段落：

```markdown
## Language

**Match the language of the source content.** Detect the dominant language of
the raw metadata / content returned by `read_concept_raw` (and `sample_rows`
if used), and write the entire OKF document — frontmatter values, prose,
schema descriptions, citations — in that same language.

- If the source is predominantly Chinese, write in Chinese.
- If the source is predominantly English, write in English.
- Keep technical identifiers (field names, code, SQL, file paths) in their
  original form; do not translate code or identifiers.
```

语言控制完全由 prompt 驱动，LLM 自动检测源内容语言，无需 CLI 参数或代码逻辑。

---

## 五、全局安装

### 方式

```bash
cd knowledge-catalog/okf
pip install --user -e ".[localfile]"
```

安装后 `reference-agent` 命令位于 `~/.local/bin/reference-agent`（需确保 `~/.local/bin` 在 `PATH` 中），任何目录可直接使用。

### 环境要求

- Python 3.11+
- `GEMINI_API_KEY` 环境变量

### 注意事项

- Gemini 免费层有限流（约 5 次/分钟），大量文件需间隔重试或使用付费 key
- 单文件上限 10MB
- 自动跳过 `.git`、`.venv`、`node_modules`、`__pycache__`、`okf-bundle` 等目录

---

## 六、中文本地化

### 翻译文件清单

| 文件                              | 说明                          |
|-----------------------------------|------------------------------|
| `okf/SPEC.zh.md`                  | OKF v0.1 规范完整中文翻译       |
| `okf/README.zh.md`                | OKF 模块中文说明               |
| `README.zh.md`                    | 仓库根目录中文说明             |
| `samples/README.zh.md`            | 示例中文说明                   |
| `toolbox/README.zh.md`            | 工具箱中文说明                 |
| `toolbox/enrichment/README.zh-CN.md` | enrichment 工具中文说明     |
| `toolbox/mdcode/README.zh-CN.md`  | mdcode 工具中文说明            |

### i18n 扩展提案

在 `SPEC.zh.md` 末尾提出了向后兼容的多语言约定：

```yaml
---
type: BigQuery Table
title: 订单表
lang: zh                        # BCP 47 语言标签
canonical: /tables/orders.md    # 指向主语言版本
---
```

完全向后兼容：不认识 `lang`/`canonical` 的 v0.1 消费者按 §4.1 忽略未知键即可。

---

## 七、改动文件汇总

### 新增文件

```
okf/src/reference_agent/sources/localfile.py    # LocalFileSource 实现
okf/src/reference_agent/sources/api_source.py   # ApiSource 实现（新增）
okf/src/reference_agent/llm_support.py           # LLM 多模型支持（新增）
okf/SPEC.zh.md                                   # OKF 规范中文翻译
okf/README.zh.md                                 # OKF 中文说明
README.zh.md                                     # 根目录中文说明
samples/README.zh.md                             # 示例中文说明
toolbox/README.zh.md                             # 工具箱中文说明
toolbox/enrichment/README.zh-CN.md               # enrichment 中文说明
toolbox/mdcode/README.zh-CN.md                   # mdcode 中文说明
```

### 修改文件

```
okf/src/reference_agent/cli.py                           # 新增 localfile 子命令 + api 源 + list-models
okf/src/reference_agent/bundle/paths.py                  # 放宽 concept ID 正则
okf/src/reference_agent/prompts/reference_instruction.md # 新增 Language 段落
okf/src/reference_agent/sources/localfile.py             # 忽略 okf-bundle 目录 + 抑制日志
okf/pyproject.toml                                        # 新增 localfile 可选依赖
okf/README.md                                             # 添加中文链接
README.md                                                 # 添加中文链接
samples/README.md                                         # 添加中文链接
toolbox/README.md                                         # 添加中文链接
toolbox/enrichment/README.md                              # 添加中文链接
toolbox/mdcode/README.md                                  # 添加中文链接
```

---

## 九、多数据源扩展（API/云端接口）

### 设计

`Source` 是抽象基类（`sources/base.py`），新增数据源只需继承它，实现 `list_concepts()` 和 `read_concept()` 方法。**不改原码**，通过 `--source` 参数选择。

新增的 `ApiSource`（`sources/api_source.py`）支持三种模式：

| 模式 | 参数 | 说明 |
|------|------|------|
| 单文件 URL | `--api-url <url>` | 直接下载远程文件（可重复） |
| API 端点 | `--api-endpoint <url>` | 返回 JSON，含文件 URL 列表 |
| URL 列表文件 | `--api-url-file <path>` | 每行一个 URL |

### 用法

```bash
# 模式1：直接指定远程文件 URL
reference-agent enrich --source api \
  --api-url https://example.com/doc1.pdf \
  --api-url https://example.com/doc2.docx \
  --out ./bundle --no-web

# 模式2：从 API 端点获取文件列表
reference-agent enrich --source api \
  --api-endpoint https://api.example.com/files \
  --api-url-field download_url \
  --api-token <bearer-token> \
  --out ./bundle --no-web

# 模式3：从 URL 列表文件读取
reference-agent enrich --source api \
  --api-url-file urls.txt \
  --out ./bundle --no-web

# 混合模式：本地文件 + 远程 URL（通过 localfile 子命令）
reference-agent localfile /local/docs \
  --pattern "**/*.pdf" \
  --api-url https://example.com/remote-doc.pdf \
  -o ./bundle
```

### 支持的远程文件格式

与本地文件相同（PDF/Word/Excel/PPT/Markdown/代码等），下载到临时目录后复用 `LocalFileSource` 的解析逻辑。

---

## 十、多 LLM 支持

### 设计

Google ADK **原生支持**多种 LLM（通过 `LLMRegistry`），无需改原码。`--model` 参数直接传模型名，ADK 自动路由到对应后端。

新增 `llm_support.py` 提供模型预设、环境变量检查和帮助信息。

### 支持的模型

```bash
reference-agent list-models   # 查看所有预设
```

| Provider | 模型 | 环境变量 | 安装 |
|----------|------|---------|------|
| **Google** | `gemini-flash-latest` | `GEMINI_API_KEY` | 内置 |
| **Google** | `gemini-2.0-flash` | `GEMINI_API_KEY` | 内置 |
| **Anthropic** | `claude-sonnet-4` | `ANTHROPIC_API_KEY` | `pip install anthropic` |
| **Anthropic** | `claude-3.5-haiku` | `ANTHROPIC_API_KEY` | `pip install anthropic` |
| **OpenAI** | `openai/gpt-4o` | `OPENAI_API_KEY` | `pip install litellm` |
| **OpenAI** | `openai/gpt-4o-mini` | `OPENAI_API_KEY` | `pip install litellm` |
| **DeepSeek** | `deepseek/deepseek-chat` | `DEEPSEEK_API_KEY` | `pip install litellm` |
| **DeepSeek** | `deepseek/deepseek-reasoner` | `DEEPSEEK_API_KEY` | `pip install litellm` |
| **通义千问** | `openai/qwen-plus` | `OPENAI_API_KEY` + `OPENAI_API_BASE` | `pip install litellm` |
| **Ollama** | `ollama/qwen2.5:7b` | 无需 | `pip install litellm` |
| **Ollama** | `ollama/llama3.2` | 无需 | `pip install litellm` |

### 用法

```bash
# Gemini（默认）
reference-agent localfile /path --model gemini-flash-latest

# Claude
export ANTHROPIC_API_KEY=xxx
reference-agent localfile /path --model claude-sonnet-4

# OpenAI
export OPENAI_API_KEY=xxx
reference-agent localfile /path --model openai/gpt-4o

# DeepSeek（国内可用，性价比高）
export DEEPSEEK_API_KEY=xxx
reference-agent localfile /path --model deepseek/deepseek-chat

# 通义千问（OpenAI 兼容接口）
export OPENAI_API_KEY=xxx
export OPENAI_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
reference-agent localfile /path --model openai/qwen-plus

# Ollama 本地模型（完全离线，无需 API Key）
ollama serve  # 先启动 ollama 服务
reference-agent localfile /path --model ollama/qwen2.5:7b
```

### 安装 LLM 依赖

```bash
# 安装 LiteLLM（支持 OpenAI/DeepSeek/通义千问/Ollama 等）
pip install litellm

# 安装 Anthropic SDK（支持 Claude）
pip install anthropic

# 一次性安装所有 LLM 扩展
pip install "google-adk[extensions]"
```

### 环境变量检查

运行时会自动检查所选模型所需的环境变量，缺失时输出提示：

```
Warning: missing env vars for deepseek/deepseek-chat: DEEPSEEK_API_KEY
模型: deepseek/deepseek-chat
  说明: DeepSeek Chat（国内可用，性价比高）
  安装: pip install litellm
  环境变量: DEEPSEEK_API_KEY
```

---

## 十一、快速验证

### 实际测试示例

```bash
# 1. 安装
cd knowledge-catalog/okf
pip install --user -e ".[localfile]"

# 2. 设置 API Key（Gemini 默认，也可换其他 LLM）
export GEMINI_API_KEY=<your-key>

# 3. 查看支持的模型
reference-agent list-models

# 4. 测试中文文件名和语言自动匹配
reference-agent localfile /Users/jianglang/CodeBuddy/LangWIKI/docs \
  --pattern "**/*.pdf" \
  -o ./pdf-bundle \
  --no-recursive

# 5. 测试多 LLM 支持（以 DeepSeek 为例）
export DEEPSEEK_API_KEY=xxx
reference-agent localfile /Users/jianglang/CodeBuddy/LangWIKI/docs \
  --pattern "**/*.md" \
  --model deepseek/deepseek-chat \
  -o ./md-bundle

# 6. 测试远程文件获取（从 GitHub 获取文件）
echo "https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/README.md" > urls.txt
echo "https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/CONTRIBUTING.md" >> urls.txt

reference-agent enrich --source api \
  --api-url-file urls.txt \
  --out ./remote-bundle \
  --no-web

# 7. 测试混合本地+远程文件
reference-agent localfile /Users/jianglang/CodeBuddy/LangWIKI/docs \
  --pattern "**/*.pdf" \
  --api-url "https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/README.md" \
  -o ./mixed-bundle

# 8. 查看生成结果
ls -la ./pdf-bundle/
cat ./pdf-bundle/index.md

# 9. 生成可视化
reference-agent visualize --bundle ./pdf-bundle
open ./pdf-bundle/viz.html
```

### 功能验证

```bash
# 运行完整功能测试
cd knowledge-catalog/okf
python test_all_features.py
```

测试脚本会验证：
- localfile 子命令正常工作
- 中文文件名支持
- 语言自动匹配
- 多数据源（API）支持
- 多 LLM 模型支持
- 支持的文件格式

### 实际工作流程示例

假设您有多个本地文档和远程资源需要整理：

```bash
# 创建工作目录
mkdir -p ~/my-knowledge-base
cd ~/my-knowledge-base

# 1. 收集本地文档
cp ~/Documents/*.pdf .
cp ~/Documents/*.docx .

# 2. 收集远程资源 URL
cat > remote_urls.txt << EOF
https://example.com/api-docs.pdf
https://example.com/guide.docx
EOF

# 3. 生成知识库（使用 DeepSeek）
export DEEPSEEK_API_KEY=your_deepseek_key
reference-agent localfile . \
  --pattern "**/*.{pdf,docx}" \
  --api-url-file remote_urls.txt \
  --model deepseek/deepseek-chat \
  -o ./knowledge-bundle

# 4. 查看生成的知识库
tree ./knowledge-bundle
open ./knowledge-bundle/viz.html
```

### 常见问题解决

1. **Gemini API 限流错误 (429)**
   ```bash
   # 等待 30 秒后重试，或使用付费 API Key
   # 或切换到其他 LLM：
   export DEEPSEEK_API_KEY=xxx
   reference-agent localfile /path --model deepseek/deepseek-chat
   ```

2. **中文文件名错误**
   ```bash
   # 已修复，确保使用最新代码
   git pull origin main
   pip install --user -e ".[localfile]"
   ```

3. **缺少依赖**
   ```bash
   # 安装所有依赖
   pip install --user -e ".[localfile]"
   pip install litellm anthropic
   ```

4. **Ollama 本地模型**
   ```bash
   # 先启动 Ollama 服务
   ollama serve &
   # 拉取模型（首次使用）
   ollama pull qwen2.5:7b
   # 使用本地模型
   reference-agent localfile /path --model ollama/qwen2.5:7b
   ```
```
