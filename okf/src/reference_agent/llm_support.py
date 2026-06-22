"""
LLM 扩展支持 — 让 reference-agent 支持本地和其他 LLM

Google ADK 原生支持多种 LLM（通过模型注册表），无需改原码：
  - Google Gemini:  gemini-flash-latest, gemini-2.0-flash
  - Anthropic Claude: claude-sonnet-4, claude-3.5-haiku
  - OpenAI:          openai/gpt-4o, openai/gpt-4o-mini
  - DeepSeek:        deepseek/deepseek-chat
  - 通义千问:         openai/qwen-plus  (OpenAI 兼容接口)
  - Ollama 本地:      ollama/qwen2.5:7b, ollama/llama3.2

使用方式（通过 --model 参数指定，无需改原码）：

  # Gemini（默认）
  reference-agent localfile /path --model gemini-flash-latest

  # Claude
  reference-agent localfile /path --model claude-sonnet-4

  # OpenAI
  reference-agent localfile /path --model openai/gpt-4o

  # DeepSeek（国内可用）
  reference-agent localfile /path --model deepseek/deepseek-chat

  # 通义千问（OpenAI 兼容接口）
  reference-agent localfile /path --model openai/qwen-plus

  # Ollama 本地模型（完全离线）
  reference-agent localfile /path --model ollama/qwen2.5:7b

环境变量配置：
  # Gemini（默认）
  export GEMINI_API_KEY=xxx

  # OpenAI / 通义千问（OpenAI 兼容）
  export OPENAI_API_KEY=xxx
  # 通义千问需额外设置 base_url：
  export OPENAI_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1

  # DeepSeek
  export DEEPSEEK_API_KEY=xxx

  # Claude
  export ANTHROPIC_API_KEY=xxx

  # Ollama（本地，无需 key）
  # 先启动 ollama: ollama serve
  # 环境变量设置 Ollama 端点（默认 http://localhost:11434）

安装依赖：
  pip install litellm          # OpenAI/DeepSeek/Qwen 等所有 OpenAI 兼容接口
  pip install anthropic        # Claude
  # Ollama 无需额外 Python 依赖，通过 litellm 的 ollama/ 前缀调用

设计原则：不改原码。ADK 的 LLMRegistry 会根据 --model 参数自动路由到对应的 LLM 后端。
"""

from __future__ import annotations

import os
from typing import Any


# ============================================================
# 模型预设 — 常用模型的环境变量和安装提示
# ============================================================

MODEL_PRESETS: dict[str, dict[str, Any]] = {
    # Google Gemini（默认，原项目支持）
    "gemini-flash-latest": {
        "provider": "google",
        "env_vars": ["GEMINI_API_KEY"],
        "install": "",
        "note": "Google Gemini，默认模型",
    },
    "gemini-2.0-flash": {
        "provider": "google",
        "env_vars": ["GEMINI_API_KEY"],
        "install": "",
        "note": "Google Gemini 2.0 Flash",
    },

    # Anthropic Claude
    "claude-sonnet-4": {
        "provider": "anthropic",
        "env_vars": ["ANTHROPIC_API_KEY"],
        "install": "pip install anthropic",
        "note": "Anthropic Claude Sonnet 4",
    },
    "claude-3.5-haiku": {
        "provider": "anthropic",
        "env_vars": ["ANTHROPIC_API_KEY"],
        "install": "pip install anthropic",
        "note": "Anthropic Claude 3.5 Haiku（快）",
    },

    # OpenAI
    "openai/gpt-4o": {
        "provider": "openai",
        "env_vars": ["OPENAI_API_KEY"],
        "install": "pip install litellm",
        "note": "OpenAI GPT-4o",
    },
    "openai/gpt-4o-mini": {
        "provider": "openai",
        "env_vars": ["OPENAI_API_KEY"],
        "install": "pip install litellm",
        "note": "OpenAI GPT-4o-mini（便宜）",
    },

    # DeepSeek（国内可用，性价比高）
    "deepseek/deepseek-chat": {
        "provider": "deepseek",
        "env_vars": ["DEEPSEEK_API_KEY"],
        "install": "pip install litellm",
        "note": "DeepSeek Chat（国内可用，性价比高）",
    },
    "deepseek/deepseek-reasoner": {
        "provider": "deepseek",
        "env_vars": ["DEEPSEEK_API_KEY"],
        "install": "pip install litellm",
        "note": "DeepSeek R1 推理模型",
    },

    # 通义千问（OpenAI 兼容接口）
    "openai/qwen-plus": {
        "provider": "qwen",
        "env_vars": ["OPENAI_API_KEY", "OPENAI_API_BASE"],
        "install": "pip install litellm",
        "note": "通义千问，需设置 OPENAI_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1",
    },

    # Ollama 本地模型（完全离线）
    "ollama/qwen2.5:7b": {
        "provider": "ollama",
        "env_vars": [],
        "install": "pip install litellm",
        "note": "Ollama 本地 Qwen2.5 7B（离线，无需 API Key）",
    },
    "ollama/llama3.2": {
        "provider": "ollama",
        "env_vars": [],
        "install": "pip install litellm",
        "note": "Ollama 本地 Llama 3.2（离线）",
    },
}


def check_model_env(model: str) -> list[str]:
    """检查模型所需的环境变量是否已设置，返回缺失列表"""
    preset = MODEL_PRESETS.get(model)
    if not preset:
        # 未知模型，不做检查
        return []
    missing = []
    for var in preset.get("env_vars", []):
        if not os.environ.get(var):
            missing.append(var)
    return missing


def get_model_help(model: str) -> str:
    """获取模型的帮助信息"""
    preset = MODEL_PRESETS.get(model)
    if not preset:
        return f"未知模型: {model}。ADK 支持的格式: gemini-*, claude-*, openai/*, deepseek/*, ollama/*"
    lines = [f"模型: {model}", f"  说明: {preset['note']}"]
    if preset["install"]:
        lines.append(f"  安装: {preset['install']}")
    if preset["env_vars"]:
        lines.append(f"  环境变量: {', '.join(preset['env_vars'])}")
    return "\n".join(lines)


def list_supported_models() -> str:
    """列出所有预设模型"""
    lines = ["支持的 LLM 模型预设：", ""]
    current_provider = ""
    for model, preset in MODEL_PRESETS.items():
        if preset["provider"] != current_provider:
            current_provider = preset["provider"]
            lines.append(f"  [{current_provider}]")
        env = ", ".join(preset["env_vars"]) if preset["env_vars"] else "无需"
        lines.append(f"    {model:40s} {preset['note']}")
    lines.append("")
    lines.append("使用: reference-agent localfile /path --model <model>")
    lines.append("提示: 也支持任意 LiteLLM 兼容模型，格式为 provider/model-name")
    return "\n".join(lines)
