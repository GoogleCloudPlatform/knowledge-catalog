# Knowledge Catalog Discovery Agent

## ℹ️ About

The Knowledge Catalog Discovery Agent is an AI-powered search assistant for discovering data assets in Google Cloud. While standard semantic search only matches semantically similar text, this agent goes further by performing semantic decomposition of complex questions, generating multiple relevant search queries, and reranking the final results to provide a comprehensive answer.

## 🚀 Quick Start

### Prerequisites

You need a Google Cloud project with the following APIs enabled:
* Knowledge Catalog (`dataplex.googleapis.com`)
* Vertex AI (`aiplatform.googleapis.com`)
* Service Usage API (`serviceusage.googleapis.com`)

Ensure you have the following permissions via IAM Roles:
* `dataplex.projects.search` - can be obtained via roles like `roles/dataplex.viewer`.
* `aiplatform.endpoints.predict` - can be obtained via roles like `roles/aiplatform.user`.
* `serviceusage.services.use` - needed to use the current project as the quota project. Can be obtained via roles like `roles/serviceusage.serviceUsageConsumer`.

### Setup

Clone the Github Repository:  
```shell  
git clone https://github.com/GoogleCloudPlatform/dataplex-labs.git  
```

Install the dependencies. It is recommended to create a Python Virtual Environment:  
```shell  
python3 -m venv /tmp/kcsearch  
source /tmp/kcsearch/bin/activate  
pip3 install -r requirements.txt  
```

Set the required environment variables:  
```shell

# Replace <PROJECT_ID> with your consumer project ID.
export GOOGLE_CLOUD_PROJECT=<PROJECT_ID>
export GOOGLE_GENAI_USE_VERTEXAI=True

```

### Run the Agent
There are 2 ways to run the Knowledge Catalog Discovery agent:  

1. *As the root agent* - in this case, rename the `discovery_agent` variable in `agent.py` to `root_agent` and run it using ADK CLI (steps below).

2. *As a sub-agent* - in this case, import the Discovery Agent and leverage it as an `AgentTool`. You can find examples of this in the official [ADK docs](https://adk.dev/agents/multi-agents/#c-explicit-invocation-agenttool). The recommended parent folder structure in this case is:

```
my_custom_agent/
├── agent.py
└── knowledge_catalog_discovery_agent/
    ├── SKILL.md
    ├── agent.py
    ├── tools.py
    └── utils.py
```

Irrespective of the path you choose, the agent can be run using the ADK CLI commands below:  

```shell
adk run path/to/agent/parent/folder
```
Replace `path/to/agent/parent/folder` with the relative or absolute path to the **parent** directory of the one containing the agent's source code.


## 📚 References

* [Knowledge Catalog Search API](http://docs.cloud.google.com/dataplex/docs/reference/rest/v1/projects.locations/searchEntries)
* [ADK Documentation](https://adk.dev/get-started/python/#run-your-agent)
* [Predefined IAM Roles](https://docs.cloud.google.com/iam/docs/roles-permissions)
