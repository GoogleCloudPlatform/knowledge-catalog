[🇺🇸 English](./README.md) | [🇨🇳 中文](./README.zh.md) | [🇨🇳 开发](./README.dev.md)

# Knowledge Catalog

[Knowledge Catalog](https://cloud.google.com/products/knowledge-catalog) (formerly Dataplex), is an AI-powered data catalog and metadata management platform. It provides a dynamic knowledge graph of all your data, structured and unstructured, to provide semantics and business context to AI agents

This repository features tools, agents, and samples that demonstrate Knowledge Catalog features, and building context management, enrichment and retrieval solutions.


## Getting Started

[![Open in Cloud Shell](http://gstatic.com/cloudssh/images/open-btn.svg)](https://console.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https%3A%2F%2Fgithub.com%2FGoogleCloudPlatform%2Fknowledge-catalog.git)

---

## ✨ Community Extensions (Fork Features)

This fork extends the original `reference-agent` beyond BigQuery into a **general-purpose OKF knowledge base generator** — from local files, remote APIs, and with multi-LLM support. All changes are backward compatible; the original `enrich` command is untouched.

### What's New

| Feature | Description |
|---------|-------------|
| 📁 **Local file source** | Generate OKF bundles from 16 file formats: PDF, Word, Excel, PPT, Markdown, code, config, HTML, CSV |
| 🌐 **Remote API source** | Fetch files from URLs, API endpoints, or URL list files (`--source api`) |
| 🤖 **Multi-LLM support** | Gemini, Claude, OpenAI, DeepSeek, Qwen, Ollama — pick any via `--model` |
| 🇨🇳 **Chinese support** | Unicode filenames + automatic language matching (source is Chinese → output is Chinese) |
| ⚡ **`localfile` shortcut** | One-command workflow: `reference-agent localfile /path --pattern "**/*.pdf"` |

### Quick Start

```bash
# Install
cd okf
pip install --user -e ".[localfile]"
pip install litellm                          # multi-LLM support

# Generate a knowledge base from local PDFs (default: Gemini)
reference-agent localfile ~/Documents --pattern "**/*.pdf"

# Use DeepSeek (works in China, cost-effective)
export DEEPSEEK_API_KEY=xxx
reference-agent localfile ~/Documents --model deepseek/deepseek-chat

# Mix local files + remote URLs
reference-agent localfile ~/docs --api-url https://example.com/remote.pdf

# View supported LLM models
reference-agent list-models

# Generate interactive HTML graph
reference-agent visualize --bundle ./okf-bundle
```

### Documentation

- 📖 **[Development Guide](./README.dev.md)** — Full feature docs, architecture, and examples (中文)
- 📋 **[Implementation Summary](./IMPLEMENTATION_SUMMARY.md)** — Complete change log and design decisions
- 🇨🇳 **[中文说明](./okf/README.zh.md)** — OKF module usage in Chinese

---

## Contributing

See the contributing [instructions](CONTRIBUTING.md) to get started contributed.


## License

All solutions within this repository are provided under the [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) license. Please see [LICENSE](LICENSE.md) for more detailed terms and conditions.


## Disclaimer

This repository and its contents are not an official Google product.
