# 开放知识格式 (OKF)

[🇺🇸 English](./README.md) | [🇨🇳 中文](./README.zh.md)

---

### 📖 [阅读 OKF v0.1 规范 → SPEC.zh.md](SPEC.zh.md)

> **本仓库主要关于 [开放知识格式 (OKF)](SPEC.zh.md)。**
>
> OKF 是一种**通用、厂商中立的格式**，用于将知识表示为
> 带 YAML frontmatter 的纯 Markdown 文件。它**不绑定任何特定的智能体、框架、模型提供商或服务系统**。目标很简单：
>
> - **任何人都可以生产** OKF —— 人工手写的、基于任何框架（Google ADK、LangChain、自定义）构建的智能体、从现有目录（Dataplex、Unity Catalog、Collibra 等）导出的管道，或遍历数据库的脚本。
> - **任何人都可以服务和消费** OKF —— 静态文件服务器、知识管理 UI（Obsidian、Notion、MkDocs）、加载文件到上下文的 LLM、搜索索引，或像本仓库中捆绑的那个图谱查看器。
>
> 下面的智能体是一个**概念验证**，演示了自动生产 OKF 捆绑包的*一种*方式。格式本身是贡献；这个智能体和可视化工具的存在是为了让格式在生产和消费两端都变得具体。
>
> **查看实践中的 OKF** —— 三个由这个智能体生产的、可以直接浏览的捆绑包，签入到 [`bundles/`](bundles/)：
>
> - [`bundles/ga4/`](bundles/ga4/) — GA4 电商数据集
>   ([viz.html](bundles/ga4/viz.html))
> - [`bundles/stackoverflow/`](bundles/stackoverflow/) — Stack Overflow
>   公共数据集 ([viz.html](bundles/stackoverflow/viz.html))
> - [`bundles/crypto_bitcoin/`](bundles/crypto_bitcoin/) — 比特币
>   区块/交易 ([viz.html](bundles/crypto_bitcoin/viz.html))

## 为什么需要 OKF？

OKF 将目录知识表示为带 YAML frontmatter 的纯 Markdown 文件，按目录层级组织。这个选择解锁了一些从服务拥有的元数据存储中难以获得的特性：

- **对人和智能体都可读。** 在读者和内容之间没有任何 SDK 或查询语言。工程师可以 `cat` 一个概念；LLM 可以将其逐字摄入上下文。
- **开箱即用的版本控制。** 捆绑包存放在 git 中。拉取请求、逐行差异、追溯和审查工作流都能正常工作 —— 知识策展变成了普通的软件工程活动。
- **可移植且无锁定。** 捆绑包是一个目录。将其作为 tarball 分发，托管在任何仓库中，从任何文件系统挂载，或同步到任何支持文件的系统。在你的元数据和你之间没有任何专有 API。
- **刻意混合结构化和非结构化数据。** 使用 frontmatter 来存储你想要查询、过滤或索引的少数字段（`type`、`resource`、`tags`、`timestamp`）；使用 Markdown 正文来存储散文、模式和示例查询，这些才是 LLM 和人类实际阅读的内容。
- **最小限度主观臆断，自由可扩展。** 一小套必需键确保了互操作性，但捆绑包可以携带任意额外的 frontmatter 键和任意正文章节，而不会破坏消费者。
- **与现有工具组合。** 许多知识工具 —— Notion、Obsidian、MkDocs、Hugo、Jekyll —— 已经支持 Markdown 加 YAML frontmatter，因此捆绑包可以在没有自定义 UI 的情况下被浏览、编辑或渲染。
- **内置渐进式展开。** 自动生成的 `index.md` 文件让智能体或人类一次浏览一个层级的目录，而不是将整个捆绑包加载到上下文中。
- **图谱形状，而不仅仅是树形。** 概念通过普通 Markdown 链接相互链接，表达比目录布局所隐含的父/子更丰富的关系。

最终效果是，参考智能体、消费智能体和人类以他们已经在源代码上协作的相同方式，在同一工件上协作。

## 安装

```bash
python3.13 -m venv .venv
.venv/bin/pip install --index-url https://pypi.org/simple/ -e .[dev]
```

## 凭证

- **BigQuery：** `gcloud auth application-default login` 加上用于计费的项目（`gcloud config set project <id>`）。公共数据集是可读的，但调用者的项目会按查询字节数计费。
- **Gemini：** 设置 `GEMINI_API_KEY`（AI Studio）**或者** 通过设置 `GOOGLE_GENAI_USE_VERTEXAI=true`、`GOOGLE_CLOUD_PROJECT=<id>` 和 `GOOGLE_CLOUD_LOCATION=<region>` 来使用 Vertex AI。

## 参考智能体如何工作

参考智能体分两轮运行。**BQ 轮**为每个源通告的概念写入一个 OKF 文档，仅使用 BigQuery 元数据。**Web 轮**然后让 LLM 作为自己的爬虫：它接收一个种子 URL 列表（通过 `--web-seed` 或 `--web-seed-file` 提供），通过 `fetch_url` 工具获取种子，并根据它们是否看起来像现有概念的权威文档来决定哪些出站链接值得跟踪。对于它获取的每个页面，智能体选择 (a) 丰富一个或多个现有概念文档，(b) 铸造一个独立的 `references/<slug>` 文档，或 (c) 跳过。在工具内部强制执行硬性的 `--web-max-pages` 上限和同域允许主机过滤器（可通过 `--web-allowed-host` 配置），因此智能体不会 overrun。使用 `--no-web` 跳过 Web 轮。

## 运行

最小调用 —— 指向一个 BigQuery 数据集和一个捆绑包输出目录。Web 轮的种子是显式的；省略它们（或传递 `--no-web`）以仅运行 BQ：

```bash
.venv/bin/python -m reference_agent enrich \
    --source bq \
    --dataset <project>.<dataset> \
    --web-seed-file <path/to/seeds.txt> \
    --out ./bundles/<name>
```

通过添加 `--concept <type>/<name>`（例如 `--concept tables/events_`）来迭代单个概念；可重复。

## 从本地文件生成 OKF

`localfile` 子命令是 `enrich --source localfile --no-web` 的快捷方式，专为从本地文件（PDF/Word/Excel/PPT/Markdown/代码等）生成知识库而设计。它自动跳过 Web 轮，使用位置参数和合理默认值，命令更简洁。

### 安装

```bash
cd knowledge-catalog/okf
python3.11 -m venv .venv
.venv/bin/pip install -e ".[localfile]"
```

安装后 `reference-agent` 命令全局可用（确保 `~/.local/bin` 在 `PATH` 中）：

```bash
pip install --user -e ".[localfile]"
```

### 凭证

设置 Gemini API Key：

```bash
export GEMINI_API_KEY=<your-key>
```

### 用法

```bash
# 最简形式：扫描当前目录，输出到 ./okf-bundle/
cd /path/to/docs
reference-agent localfile

# 指定文件类型（推荐）
reference-agent localfile --pattern "**/*.pdf"

# 指定源目录和输出目录
reference-agent localfile /path/to/docs --pattern "**/*.pdf" -o ./my-bundle

# 指定模型 + 详细日志
reference-agent localfile /path/to/docs --model gemini-flash-latest -v

# 仅处理特定概念（可重复）
reference-agent localfile /path/to/docs --concept "ERP_WIKI"
```

### 参数说明

| 参数               | 默认值            | 说明                                          |
|--------------------|-------------------|-----------------------------------------------|
| `path`             | `.`（当前目录）   | 要扫描的本地目录（位置参数，可选）              |
| `--pattern`        | `**/*`            | 文件匹配模式，如 `**/*.pdf`、`**/*.{md,txt}`   |
| `-o / --out`       | `./okf-bundle`    | 输出目录                                       |
| `--model`          | `gemini-flash-latest` | Gemini 模型 ID                            |
| `--no-recursive`   | *(关闭)*          | 禁用递归扫描                                   |
| `--concept`        | *(全部)*          | 仅处理指定概念 ID（可重复）                     |
| `-v / --verbose`   | *(关闭)*          | 详细日志输出                                   |

### 支持的文件类型

> 原项目仅支持 BigQuery 数据源。其中 PDF/Word/Excel/PPT 为新增文档格式（需安装可选依赖），其余为基础文本格式（内置支持）。

#### 新增文档格式（需安装 `[localfile]` 可选依赖）

| 扩展名                    | 概念类型               | 解析方式                    | 新增 |
|---------------------------|------------------------|-----------------------------|------|
| `.pdf`                    | PDF Document           | pdfplumber 提取文本         | ✅   |
| `.docx`                   | Word Document          | python-docx 提取段落        | ✅   |
| `.xlsx` / `.xls`          | Excel Spreadsheet      | pandas + openpyxl，限50行   | ✅   |
| `.pptx` / `.ppt`          | PowerPoint Presentation| python-pptx 提取幻灯片      | ✅   |

#### 基础文本格式（内置支持，无需额外依赖）

| 扩展名                    | 概念类型               | 解析方式                    |
|---------------------------|------------------------|-----------------------------|
| `.md` / `.markdown`       | Document               | 直接读取 UTF-8              |
| `.txt`                    | Document               | UTF-8，回退 GBK             |
| `.py` / `.ts` / `.js`     | Python/TypeScript/JavaScript Module | 读取，超8000字符截断 |
| `.json` / `.yaml` / `.yml`| Config File            | 直接读取                    |
| `.html`                   | HTML Document          | 读取，超8000字符截断        |
| `.csv`                    | Data File              | 支持采样前5行               |

### 语言自动匹配

智能体会自动检测源文件内容的主导语言，并用相同语言生成 OKF 文档：
- 源文件是中文 → 生成中文 OKF 文档
- 源文件是英文 → 生成英文 OKF 文档
- 技术标识符（字段名、代码、SQL、文件路径）保持原样不翻译

### 示例

从 `docs/` 目录下的 PDF 生成知识库：

```bash
cd /Users/jianglang/CodeBuddy/LangWIKI/docs
reference-agent localfile --pattern "**/*.pdf" -o ./pdf-bundle
```

生成的结构：

```
docs/
├── Karpathy LLM 编程行为.pdf
├── ERP-WIKI.pdf
├── LLM-wiki.pdf
└── pdf-bundle/                    # 自动生成
    ├── index.md                   # 索引文件
    ├── Karpathy_LLM_编程行为.md    # 概念文档
    ├── ERP_WIKI.md
    └── LLM_wiki.md
```

### 可视化

生成 OKF 捆绑包后，可生成交互式 HTML 图谱：

```bash
reference-agent visualize --bundle ./pdf-bundle
# → 生成 ./pdf-bundle/viz.html
```

### 注意事项

- **API 限流**：Gemini 免费层有限流（约 5 次/分钟），大量文件时可能遇到 429 错误，等待 30 秒后重试或使用付费 key。
- **文件大小**：单文件上限 10MB。
- **忽略目录**：`.git`、`.venv`、`node_modules`、`__pycache__`、`okf-bundle` 等目录会被自动跳过。

## 多数据源支持

除了本地文件，`reference-agent` 现在支持多种数据源：

### 1. 本地文件 (localfile)
```bash
reference-agent localfile /path/to/docs --pattern "**/*.pdf"
```

### 2. 远程 URL (API 源)
```bash
# 从指定 URL 获取文件
reference-agent enrich --source api \
    --api-url https://raw.githubusercontent.com/.../README.md \
    --api-url https://raw.githubusercontent.com/.../CONTRIBUTING.md \
    --out ./api-bundle

# 从 API 端点获取文件列表
reference-agent enrich --source api \
    --api-endpoint https://api.example.com/files \
    --api-url-field "download_url" \
    --api-token $API_TOKEN \
    --out ./remote-bundle

# 从文本文件读取 URL 列表
echo "https://example.com/file1.pdf" > urls.txt
echo "https://example.com/file2.docx" >> urls.txt
reference-agent enrich --source api \
    --api-url-file urls.txt \
    --out ./url-bundle
```

### 3. 混合本地和远程文件
```bash
# localfile 子命令支持混合
reference-agent localfile /path/to/local/docs \
    --pattern "**/*.pdf" \
    --api-url https://example.com/remote-file.pdf \
    --api-token $TOKEN \
    -o ./mixed-bundle
```

## 多 LLM 支持

不再局限于 Gemini！`reference-agent` 现在支持多种 LLM：

### 支持的模型（通过 `--model` 参数指定）

```bash
# 查看所有支持的模型
reference-agent list-models

# 使用不同模型
reference-agent localfile /path --model gemini-flash-latest      # Google Gemini（默认）
reference-agent localfile /path --model claude-sonnet-4          # Anthropic Claude
reference-agent localfile /path --model openai/gpt-4o            # OpenAI GPT-4o
reference-agent localfile /path --model deepseek/deepseek-chat   # DeepSeek（国内可用）
reference-agent localfile /path --model openai/qwen-plus         # 通义千问（OpenAI 兼容接口）
reference-agent localfile /path --model ollama/qwen2.5:7b        # Ollama 本地模型
```

### 环境变量配置

```bash
# Gemini（默认）
export GEMINI_API_KEY=xxx

# OpenAI / 通义千问
export OPENAI_API_KEY=xxx
export OPENAI_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1  # 仅通义千问需要

# DeepSeek
export DEEPSEEK_API_KEY=xxx

# Claude
export ANTHROPIC_API_KEY=xxx

# Ollama（本地，无需 key，但需启动服务）
ollama serve  # 启动 Ollama 服务
# 默认端点：http://localhost:11434
```

### 依赖安装

```bash
# 安装 litellm（支持 OpenAI/DeepSeek/Qwen/Ollama）
pip install litellm

# 安装 Claude 支持
pip install anthropic

# 安装本地文件处理依赖
pip install ".[localfile]"
```

### 模型选择建议

| 使用场景 | 推荐模型 | 优点 |
|---------|----------|------|
| 免费使用 | `gemini-flash-latest` | Google 免费层，但有限流 |
| 国内环境 | `deepseek/deepseek-chat` | 国内可用，性价比高 |
| 高质量 | `claude-sonnet-4` | 推理能力强 |
| 离线使用 | `ollama/qwen2.5:7b` | 完全离线，无需 API key |
| 中文优化 | `openai/qwen-plus` | 通义千问，中文理解好 |

## 示例

每个示例将一个**配方**（`samples/<name>/`，包含种子 URL 和确切的 `enrich` 命令）与配方生成的**生产的捆绑包**（`bundles/<name>/`）配对。打开配方以重现；打开捆绑包以直接浏览结果：

- **GA4 Google Merchandise Store** — 公共电商数据集，用规范的 GA4 BigQuery Export 文档 URL 作为种子。
  · [配方](samples/ga4_merch_store/README.md)
  · [捆绑包](bundles/ga4/)
  · [viz.html](bundles/ga4/viz.html)
- **Stack Overflow** — 公共数据集（Stack Exchange 数据转储的镜像），用社区规范的模式引用作为种子。练习来自横切文档页面的多概念丰富。
  · [配方](samples/stackoverflow/README.md)
  · [捆绑包](bundles/stackoverflow/)
  · [viz.html](bundles/stackoverflow/viz.html)
- **Bitcoin (crypto)** — 来自 `bitcoin-etl` 管道的公共数据集（区块、交易、输入、输出）。练习散文中的跨表外键关系。
  · [配方](samples/crypto_bitcoin/README.md)
  · [捆绑包](bundles/crypto_bitcoin/)
  · [viz.html](bundles/crypto_bitcoin/viz.html)

## 可视化

`visualize` 子命令将任何 OKF 捆绑包渲染为**自包含的交互式 HTML 文件** —— 一个文件，在查看端无需后端、无需安装。在任何现代浏览器中打开它，将其作为工件共享，将其托管在静态文件服务器上，或将其与捆绑包一起签入（就像本仓库所做的那样）。

查看器本身就是一个 OKF 的*消费端*概念验证，就像参考智能体是*生产端*概念验证一样。OKF 捆绑包可以被任何读取 Markdown 的东西消费；这只是一种形式。

### 它显示什么

- 捆绑包中每个概念的**力导向图谱**，按类型（数据集、表、引用等）着色的节点，以及从 Markdown 正文中的每个交叉链接绘制的有向边。
- 所选概念的**详情面板**，显示其 frontmatter（描述、资源链接、标签）及其渲染的 Markdown 正文 —— 内部的 `[…](/path/to/concept.md)` 链接被重新接线以在查看器内导航，而不是跟随路径。
- 每个概念下的**"被引用"反向链接**列表（从链接图谱的反向计算）。
- **搜索框**（匹配标题、概念 ID 和标签）、**类型过滤器**，以及可切换的图谱布局（cose / concentric / breadthfirst / circle / grid）。

### 生成

```bash
.venv/bin/python -m reference_agent visualize --bundle ./bundles/<name>
```

这会写入 `bundles/<name>/viz.html`。标志：

| 标志           | 默认                | 描述                                 |
|----------------|------------------------|---------------------------------------------|
| `--bundle`     | *(必需)*           | 捆绑包根目录。                      |
| `--out`        | `<bundle>/viz.html`    | 输出 HTML 路径。                           |
| `--name`       | 捆绑包目录名  | 查看器标题中显示的显示名称。    |

示例，将输出写到别处并覆盖标题：

```bash
.venv/bin/python -m reference_agent visualize \
    --bundle ./bundles/crypto_bitcoin \
    --out /tmp/btc.html \
    --name "Bitcoin OKF"
```

### 它是如何构建的

HTML 将捆绑包作为 JSON blob 嵌入，并使用 [Cytoscape.js](https://js.cytoscape.org/) 处理图谱，使用 [marked](https://marked.js.org/) 进行浏览器内 Markdown 渲染，两者都从 CDN 加载。没有数据离开页面；捆绑包在生成时解析一次并序列化到文件中。

## 测试

```bash
.venv/bin/pytest
```
