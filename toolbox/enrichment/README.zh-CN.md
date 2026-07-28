# 丰富智能体

[🇺🇸 English](./README.md) | [🇨🇳 中文](./README.zh-CN.md)

---

Knowledge Catalog 的丰富智能体提供了一个可定制的智能体工作流，用于从各种来源提取信息以构建关于数据资产的元数据，这些元数据随后可用作上下文。

## 使用方法

### 先决条件

丰富智能体依赖于 [元数据即代码](../mdcode/README.zh-CN.md) 功能。
请按照该页面上关于使用 `kcmd` 工具的说明进行操作。

### CLI

该包提供 `kcenrich` CLI 工具。它作为独立二进制文件分发：

```bash
# 为 BigQuery 数据集初始化新的目录快照
kcmd init --bigquery-dataset <projectId>.<datasetId>

# 从 Knowledge Catalog 服务拉取最新目录快照
kcmd pull

# 运行丰富工具
kcagent enrich --catalog-path . --tools-path tools --prompt-path prompt.md
```

## 开发者工作流

### 设置

```bash
git clone https://github.com/googlecloudplatform/knowledge-catalog
cd toolbox/enrichment
npm install
```

### 构建

```bash
npm run build
```

### 测试

```bash
npm run test
```

### 演示

本仓库包含一个自包含的演示。运行演示涉及在你的云项目中创建 BigQuery 数据集和 Dataplex EntryGroup。

**初始化环境**

```bash
export DEMO_CLOUD_PROJECT="<your-gcp-project-id>"
```

**初始化 gcloud**

```bash
gcloud auth application-default login
gcloud config set project $DEMO_CLOUD_PROJECT
gcloud config set compute/region us
```

**设置演示资源**

```bash
bq query --use_legacy_sql=false <<EOF
CREATE SCHEMA IF NOT EXISTS `${DEMO_CLOUD_PROJECT}.demo_commerce`
OPTIONS (
  location = 'US',
  labels = [('usage', 'demo')]
);

CREATE TABLE IF NOT EXISTS `${DEMO_CLOUD_PROJECT}.demo_commerce.events`
PARTITION BY event_date_dt
AS
SELECT
  *,
  PARSE_DATE('%Y%m%d', event_date) AS event_date_dt
FROM
  `bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*`;
EOF
```

**创建并填充目录快照**

```bash
mkdir -p demo
cd demo
cat <<EOF > catalog.yaml
scope: bq-dataset.${DEMO_CLOUD_PROJECT}.demo_commerce

snapshot:
  entries:
    - dataplex-types.global.bigquery-dataset
    - dataplex-types.global.bigquery-table
  aspects:
    - dataplex-types.global.overview
EOF

../../mdcode/dist/kcmd pull
```

**创建并填充工具**

```bash
cat <<EOF > prompt.md
使用内部组织信息丰富资产的文档。
使用以下来源：

* 文件集来源
EOF
```

```bash
mkdir tools
cat <<EOF > tools/mcp.json
{
  "mcpServers": {
    "md-fileset": {
      "command": "../dist/md-fileset",
      "args": [ "--dir", "fileset" ]
    }
  }
}
EOF
```

```bash
mkdir -p tools/skills/fileset-source
cat <<EOF > tools/skills/fileset-source/SKILL.md
---
name: fileset-source
description: >
  使用文件集来源查找相关 Markdown 文档并提取关于资产的信息。
---

`md-fileset` MCP 服务器提供以下工具，用于从 Markdown 文件目录层级中提取相关信息：

* **list_fileset_contents** - 浏览和导航目录树以列出指定路径的内容。项目可以是文件或子目录。

* **read_fileset_file** - 读取知识库中文件的内容。提供完整内容。基于正在生成的文档提取并总结相关信息。

* **search_fileset_content** - 搜索知识库并返回匹配的文件，以及匹配的行号和行片段。这可用于快速查找匹配项，而无需列出和读取所有文件。

要有效使用文件集，请创建搜索查询（使用带单个 token 的简单关键词查询）以查找相关文件，然后读取文件以查找相关信息。如果一个查询不起作用，请尝试其他几个关键词。
EOF
```

**添加文档**  
将 [此处](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/1e97103cdbf7e6425113a73304029ddb4f1f3a6b/samples/enrichment/sample/docs) 的各个 Markdown 文件复制到 `fileset/` 目录中。

**丰富元数据**

```bash
../dist/kcagent enrich --catalog-path . --tools-path tools --prompt-path prompt.md
```

**清理**

```bash
bq rm -r ${DEMO_CLOUD_PROJECT}:demo-dataset
```
