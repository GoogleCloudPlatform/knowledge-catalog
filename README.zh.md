# Knowledge Catalog（知识目录）

[🇺🇸 English](./README.md) | [🇨🇳 中文](./README.zh.md) | [🇨🇳 开发](./README.dev.md)

---

[Knowledge Catalog](https://cloud.google.com/products/knowledge-catalog)（前身为 Dataplex）是一个 AI 驱动的数据目录和元数据管理平台。它提供你所有数据（结构化和非结构化）的动态知识图谱，为 AI 智能体提供语义和业务上下文。

本仓库包含演示 Knowledge Catalog 功能的工具、智能体和示例，以及构建上下文管理、丰富和检索解决方案。

## 快速开始

[![在 Cloud Shell 中打开](http://gstatic.com/cloudssh/images/open-btn.svg)](https://console.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https%3A%2F%2Fgithub.com%2FGoogleCloudPlatform%2Fknowledge-catalog.git)

---

## ✨ 功能扩展（Fork 特性）

本 Fork 将原 `reference-agent` 从仅支持 BigQuery 扩展为**通用 OKF 知识库生成器** —— 支持本地文件、远程 API，并支持多种 LLM。所有改动向后兼容，原 `enrich` 命令不受影响。

### 新增功能

| 功能 | 说明 |
|------|------|
| 📁 **本地文件源** | 从 16 种文件格式生成 OKF 知识包：PDF、Word、Excel、PPT、Markdown、代码、配置、HTML、CSV |
| 🌐 **远程 API 源** | 从 URL、API 端点或 URL 列表文件获取文件（`--source api`） |
| 🤖 **多 LLM 支持** | Gemini、Claude、OpenAI、DeepSeek、通义千问、Ollama —— 通过 `--model` 指定 |
| 🇨🇳 **中文支持** | Unicode 文件名 + 语言自动匹配（源是中文 → 输出中文） |
| ⚡ **`localfile` 快捷命令** | 一行命令完成：`reference-agent localfile /path --pattern "**/*.pdf"` |

### 快速上手

```bash
# 安装
cd okf
pip install --user -e ".[localfile]"
pip install litellm                          # 多 LLM 支持

# 从本地 PDF 生成知识库（默认：Gemini）
reference-agent localfile ~/Documents --pattern "**/*.pdf"

# 使用 DeepSeek（国内可用，性价比高）
export DEEPSEEK_API_KEY=xxx
reference-agent localfile ~/Documents --model deepseek/deepseek-chat

# 混合本地文件 + 远程 URL
reference-agent localfile ~/docs --api-url https://example.com/remote.pdf

# 查看支持的 LLM 模型
reference-agent list-models

# 生成交互式 HTML 图谱
reference-agent visualize --bundle ./okf-bundle
```

### 文档

- 📖 **[开发说明](./README.dev.md)** — 完整功能文档、架构和示例
- 📋 **[实现总结](./IMPLEMENTATION_SUMMARY.md)** — 完整改动日志和设计决策
- 🇨🇳 **[OKF 中文说明](./okf/README.zh.md)** — OKF 模块中文使用说明

---

## 贡献

查看贡献[说明](CONTRIBUTING.md)以开始贡献。

## 许可证

本仓库中的所有解决方案均在 [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) 许可证下提供。请参阅 [LICENSE](LICENSE.md) 以了解更详细的条款和条件。

## 免责声明

本仓库及其内容不是正式的 Google 产品。
