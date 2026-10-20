# config.py
import os

"""Configuration variables for the Policy-as-Code Agent."""

# Google Cloud Project Configuration
PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT")
LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

# Memory Bank Configuration
ENABLE_MEMORY_BANK = os.getenv("ENABLE_MEMORY_BANK", "True").lower() == "true"
FIRESTORE_DATABASE = os.getenv("FIRESTORE_DATABASE", "(default)")
FIRESTORE_COLLECTION_POLICIES = os.getenv(
    "FIRESTORE_COLLECTION_POLICIES", "policies"
)
FIRESTORE_COLLECTION_EXECUTIONS = os.getenv(
    "FIRESTORE_COLLECTION_EXECUTIONS", "policy_executions"
)
CORE_POLICIES_DOC_REF = os.getenv(
    "CORE_POLICIES_DOC_REF", "configurations/core_policies"
)
EMBEDDING_MODEL_NAME = os.getenv("EMBEDDING_MODEL_NAME", "text-embedding-004")

# LLM Configuration
GEMINI_MODEL_PRO = os.getenv("GEMINI_MODEL_PRO", "gemini-2.5-pro")
GEMINI_MODEL_FLASH = os.getenv("GEMINI_MODEL_FLASH", "gemini-2.5-flash")

# Prompt Configuration
PROMPT_CODE_GENERATION_FILE = os.getenv(
    "PROMPT_CODE_GENERATION_FILE", "code_generation.md"
)
PROMPT_REMEDIATION_FILE = os.getenv("PROMPT_REMEDIATION_FILE", "remediation.md")
PROMPT_INSTRUCTION_FILE = os.getenv(
    "PROMPT_INSTRUCTION_FILE", "instructions.md"
)

# MCP Configuration
DATAPLEX_MCP_SERVER_URL = os.getenv("DATAPLEX_MCP_SERVER_URL")

# Threading Configuration
MAX_REMEDIATION_WORKERS = int(os.getenv("MAX_REMEDIATION_WORKERS", "10"))

# Default Policies
DEFAULT_CORE_POLICIES = [
    "All tables in analytics_dataset & finance_dataset must be partitioned",
    "No tables should have a column of byte or boolean datatype",
    "The 'data_owner' label must be present on all tables.",
    "Table names must be in snake_case.",
    "For every table in the marketing_dataset that has 'performance' in its name, there must exist a table in the sales_dataset with 'summary' in its name, AND all tables in the marketing_dataset must use snake_case for all column names.",
]
