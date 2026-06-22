# 元数据即代码

[🇺🇸 English](./README.md) | [🇨🇳 中文](./README.zh-CN.md)

---

元数据即代码是 Knowledge Catalog (Dataplex) 提供的一种功能，为数据管理员、数据生产者和 AI 智能体提供基于源代码工件的元数据管理和上下文工程用户体验。

用户和智能体可以使用对开发者友好的工作流（带版本控制和 CI/CD）来编写、管理和丰富元数据工件。它提供一种标准元数据格式，可供各种工具和智能体使用。

更多详情请参见 [docs/concept.md](docs/concept.md)。

## 核心特性

- 直观且对智能体友好的元数据表示，以 YAML 和 Markdown 文件形式的源代码呈现。工件按层级组织，镜像数据和元数据资产的资源层级。
- 本地工作区与目录服务之间的双向同步。
- 支持第一方和第三方元数据构造。
- 作为 TypeScript 和 Python 库、CLI 工具 (`kcmd`) 和 MCP 服务器分发，可用于各种应用、智能体和流水线。

## 元数据工件

### 目录布局

元数据在表示资源（如 BigQuery 数据集、Dataplex EntryGroup 等）的目录中组织：

```
path/to/root/
├── catalog.yaml                       # 清单和配置指令
└── catalog/                           # 包含元数据快照
    └── <dir1>/
        └── <entry-id1>.yaml           # 条目
        └── <dir2>/
            ├── <entry-id2>.yaml       # 带侧车 Markdown 的条目
            └── <entry-id2>.aspect.md  # 文件
```

## 目录快照文件

### 清单文件

**`catalog/catalog.yaml`**

```yaml
scope: bq-dataset.prod-data.ecommerce

aliases:
  ca-guidelines:
    aspect: data-agents-project.global.ca-guidelines
  ecommerce:
    aspect: data-agents-project.global.ecommerce

snapshot:
  entries:
    - bigquery-table
    - bigquery-view
    - entry-group
  aspects:
    - overview
    - descriptions

publishing:
  aspects:
    - overview
    - descriptions
```

### 条目 YAML 文件

**`catalog/prod-data.ecommerce/products.yaml`**

```yaml
id: products
type: bigquery-table

resource:
  name: projects/prod-data/datasets/ecommerce/tables/products
  displayName: Products Table
  description: All products in the catalog
  labels:
    env: prod
  createTime: 2026-04-23T00:44:03Z
  updateTime: 2026-04-23T00:44:03Z

schema:
  ...

contacts:
  ...
```

### 条目侧车 Markdown 文件

**`catalog/prod-data.ecommerce/products.overview.md`**

```markdown
---
userManaged: true
links:
  ...
---
[overview.content]
```

## 使用方法

### 库

你可以使用 `kcmd` 库以编程方式与目录元数据交互：

```bash
npm install kcmd
```

```typescript
import * as kcmd from 'kcmd';

// 从头创建目录清单
const manifest = new kcmd.CatalogManifest(...);
manifest.save('/path/to/root');

// 从文件系统加载目录快照
const snapshot = kcmd.CatalogSnapshot.fromPath('/path/to/root');

// 从目录服务拉取最新元数据
const pullResult = await snapshot.pull();
if (pullResult.success) {
  console.log('元数据拉取成功');
}
else {
  console.error('元数据拉取失败:', pullResult.error);
}

// 将修改后的元数据推送到目录服务
const pushResult = await snapshot.push();
if (pushResult.success) {
  console.log('元数据推送成功');
}
else {
  console.error('元数据推送失败:', pushResult.error);
}
```

### CLI

该包提供 `kcmd` CLI 工具。它作为独立二进制文件分发：

```bash
# 为 BigQuery 数据集初始化新的目录快照
kcmd init --bigquery-dataset <projectId>.<datasetId>

# 为多个 BigQuery 数据集初始化新的目录快照
kcmd init --bigquery-dataset <projectId>.<datasetId1> --bigquery-dataset <projectId>.<datasetId2>

# 为带有特定类型的 BigQuery 数据集初始化新的目录快照
kcmd init --bigquery-dataset <projectId>.<datasetId> \
  --entry bigquery-table --entry bigquery-view \
  --aspect overview --aspect description

# 为自定义 EntryGroup 初始化新的目录快照
kcmd init --entry-group <projectId>.<locationId>.<entryGroupId>

# 从 Knowledge Catalog 服务拉取最新目录快照
# 报告任何尚未推送到目录的待处理变更。
# 支持使用 --dry-run 标志进行干运行。
kcmd pull

# 检查本地修改
kcmd status

# 将本地变更推送到 Knowledge Catalog 服务。仅推送自上次拉取以来的变更，
# 并且如果该元数据在此期间未在目录中被修改过。
# 支持使用 --dry-run 标志进行干运行。
kcmd push
```

注意：CLI 使用 `gcloud` 获取认证令牌，因此请确保已通过 `gcloud auth application-default login` 进行认证。

### MCP 服务器

要在智能体系统（如 Gemini CLI）中将元数据即代码工具作为 MCP 工具使用，请将以下内容添加到你的 MCP 设置文件：

```json
{
  "mcpServers": {
    "kc-mac": {
      "command": "kcmd",
      "args": ["mcp", "--path", "/path/to/root"]
    }
  }
}
```

该服务器提供以下工具：

| 工具             | 描述                                           |
|------------------|-------------------------------------------------------|
| `pull`             | 从目录服务拉取最新元数据     |
| `push`             | 将修改后的元数据推送到目录服务     |
| `list-entries`     | 列出目录快照中的条目                  |
| `lookup-entry`     | 从快照中查找条目及其元数据    |
| `modify-entry`     | 修改快照中的条目及其元数据      |

注意：该服务器使用 `gcloud` 获取认证令牌，因此请确保已通过 `gcloud auth application-default login` 进行认证。

## 开发者工作流

### 设置

```bash
git clone https://github.com/googlecloudplatform/knowledge-catalog
cd toolbox/mdcode
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
