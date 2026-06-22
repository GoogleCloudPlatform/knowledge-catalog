---
type: Specification
title: 开放知识格式(OKF)规范 · 中文版
description: OKF v0.1 规范 SPEC.md 的完整中文翻译,附硬要求与留白标注,以及 i18n 扩展提案草案。
tags: [okf, 规范, 翻译, 提案]
lang: zh
canonical: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
timestamp: 2026-06-14T00:00:00Z
author: 云中江树(译)
---

# 开放知识格式(OKF)规范 · 中文版

> 译自官方 [OKF SPEC.md v0.1 — Draft](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
> 翻译与标注:云中江树 · 本译文力求信达雅,并在关键处标注 **硬要求(MUST)** 与 **留白(交给生产者)**,方便判断"它管到哪、留给你什么"。
> 规范术语(MUST/SHOULD/MAY)按 RFC 2119 习惯译为 **必须 / 应当 / 可以**。

**版本 0.1 — 草案**

OKF 是一种开放的、对人和智能体都友好的格式,用来表示**知识**——围绕在数据与系统周围的元数据、上下文与经过梳理的洞见。它的设计目标是:可由人撰写、可由智能体生成、可跨组织交换、可被两者共同消费。

这个格式刻意保持极简:**一个目录,里面是带 YAML 头信息的 Markdown 文件**。没有 schema 注册表,没有中央权威,不需要任何工具链。你要是能 `cat` 一个文件,你就能读 OKF;你要是能 `git clone` 一个仓库,你就能分发它。

---

## 1. 动机

面向 AI 智能体的知识表示,这片领域正在飞速演化,涌现出大量互不兼容的约定。OKF 持这样一个立场:知识最好用那些**通用、可访问、已被广泛接受**的格式来表示,它们应当:

- 对人**可读**,无需工具;
- 对智能体**可解析**,无需定制 SDK;
- 在版本控制中**可 diff**;
- 跨工具、跨组织、跨时间**可移植**。

这个格式"尽量不替你做主"。它只标准化那一小套让知识语料**能自我描述**所必需的结构性约定——除此之外的一切,都交给生产者。

### 目标

1. 定义一个通用格式,供**富化智能体(enrichment agents)**写入。
2. 指导**消费智能体(consumption agents)**应当如何读取与遍历它。
3. 促进知识在系统与组织之间的**交换**。
4. 标准化那为数不多的、内容要被有意义地消费就**必须**存在的字段。

### 非目标

- 定义一套固定的概念类型分类法。
- 规定存储、服务或查询的基础设施。
- 取代领域专用 schema(Avro、Protobuf、OpenAPI 等)——OKF **引用**它们,而不吞并它们。

---

## 2. 术语

- **知识包(Knowledge Bundle)** — 一个自包含的、层级化的知识文档集合。分发的基本单位。
- **概念(Concept)** — 包内的一个知识单元,表示为一份 Markdown 文档。它可以描述一个有形资产(一张表、一个 API)、一个抽象概念(一个指标、一项业务流程),或介于两者之间的任何东西。
- **概念 ID(Concept ID)** — 概念文件在包内的路径,去掉 `.md` 后缀。例如 `tables/users.md` 的概念 ID 是 `tables/users`。
- **头信息(Frontmatter)** — Markdown 文件顶部由 `---` 界定的 YAML 元数据块。
- **正文(Body)** — 头信息之后的全部内容。
- **链接(Link)** — 从一个概念指向另一个概念的标准 Markdown 链接,用来表达超出隐式父子层级之外的关系。
- **引用(Citation)** — 从一个概念指向某个外部来源的链接,用来支撑正文中的某个论断。

---

## 3. 包结构

一个包就是一棵由 Markdown 文件组成的目录树。目录结构与领域无关——生产者按对所捕获的知识最合理的方式来组织概念。

```
path/to/bundle/
├── index.md                      # 可选。用于渐进式展开的目录清单。
├── log.md                        # 可选。变更的时间线历史。
├── <concept>.md                  # 包根目录下的一个概念。
└── <subdirectory>/               # 子目录把概念分组。
    ├── index.md
    ├── <concept>.md
    └── <subdirectory>/
        └── …
```

一个包**可以**通过以下方式分发:

- 一个 git 仓库(推荐——自带历史、归属、diff)。
- 该目录的 tarball 或 zip 压缩包。
- 一个更大仓库里的子目录。

### 3.1 保留文件名

下列文件名在层级的任意一层都有约定含义,**禁止**用作概念文档:

| 文件名     | 用途                          |
|-----------|------------------------------|
| `index.md` | 目录清单。见 §6。              |
| `log.md`   | 更新历史。见 §7。              |

所有其他 `.md` 文件都是概念文档。

标签本身仍是一等概念——见 §4.1 的 `tags` 头信息字段。OKF 不为"按标签聚合文档"另行规定文件格式;想要标签浏览视图的生产者,可以在消费时扫描头信息现场合成一个。

---

## 4. 概念文档

每个概念都是一份 UTF-8 的 Markdown 文件,由两部分组成:

1. 一个 **YAML 头信息块**,以单独成行的 `---` 开始、再以单独成行的 `---` 结束。
2. 一段 **Markdown 正文**,内容自由。

### 4.1 头信息

```yaml
---
type: <类型名>                      # 必须
title: <可选的显示名>
description: <可选的一句话摘要>
resource: <可选:底层资产的规范 URI>
tags: [<标签>, <标签>, …]           # 可选
timestamp: <ISO 8601 时间>          # 可选:最后修改时间
# … 其他由生产者自定义的键值对
---
```

**必须:**

- `type` — 一个短字符串,标识概念的种类。消费者用它来做路由、过滤和呈现。示例取值:`BigQuery Table`、`BigQuery Dataset`、`API Endpoint`、`Metric`、`Playbook`、`Reference`。

  类型取值**不**做中央注册。生产者**应当**选取具有描述性、自解释的取值;消费者**必须**优雅地容忍未知类型(通常就当作通用概念处理)。

**推荐(按优先级):**

- `title` — 人类可读的显示名。若省略,消费者**可以**从文件名推导标题。
- `description` — 概括该概念的一句话。被 `index.md` 生成器、搜索摘要和预览使用。
- `resource` — 唯一标识该概念所描述底层资产的 URI。对描述抽象概念(而非物理资源)的概念,可缺省。
- `tags` — 一个 YAML 列表,放短字符串,用于横切分类。
- `timestamp` — 最后一次有意义变更的 ISO 8601 时间。

**扩展:** 生产者**可以**加入任意额外的键。消费者在往返处理(round-trip)时**应当**保留未知键,并且**不应当**因为出现无法识别的字段就拒绝文档。

> 🧭 **留白提示:** OKF 在头信息上唯一的硬要求就是 `type` 非空(见 §9)。其余字段全是推荐。这意味着"扩展字段"是规范明牌鼓励的口子——本仓库的 `lang` / `canonical` 多语言约定正是借此实现(见文末)。

### 4.2 正文

正文是标准 Markdown。生产者**应当**偏好结构化 Markdown——标题、列表、表格、围栏代码块——而非自由散文,因为结构既利于人阅读,也利于智能体检索。

没有任何必须的正文章节。下列章节标题具有**约定**含义,适用时**应当**使用:

| 标题          | 用途                                  |
|--------------|--------------------------------------|
| `# Schema`   | 对资产的列/字段的结构化描述。           |
| `# Examples` | 具体的使用示例,通常用围栏代码块。       |
| `# Citations`| 支撑正文论断的外部来源。见 §8。         |

> 🧭 **留白提示:** 正文只约定了三个标题,且全是"应当"。**格式不保证正文质量**——这正是"作品占位"能发力的地方。

### 4.3 示例:一个绑定到资源的概念

```markdown
---
type: BigQuery Table
title: Customer Orders
description: One row per completed customer order across all channels.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders
tags: [sales, orders, revenue]
timestamp: 2026-05-28T14:30:00Z
---

# Schema

| Column        | Type      | Description                              |
|---------------|-----------|------------------------------------------|
| `order_id`    | STRING    | Globally unique order identifier.        |
| `customer_id` | STRING    | Foreign key into [customers](/tables/customers.md). |
| `total_usd`   | NUMERIC   | Order total in US dollars.               |
| `placed_at`   | TIMESTAMP | When the customer submitted the order.   |

# Joins

Joined with [customers](/tables/customers.md) on `customer_id`.

# Citations

[1] [BigQuery table schema](https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders)
```

### 4.4 示例:一个不绑定资源的概念

```markdown
---
type: Playbook
title: Incident response — data freshness alert
description: Steps to triage a freshness alert on the orders pipeline.
tags: [oncall, incident]
timestamp: 2026-04-12T09:00:00Z
---

# Trigger

A freshness alert fires when `orders` lags more than 30 minutes behind
its expected SLA. See the [orders table](/tables/orders.md).

# Steps

1. Check the [ingestion job dashboard](https://example.com/dash).
2. …
```

---

## 5. 交叉链接

概念**可以**用标准 Markdown 链接指向其他概念。支持两种形式:

### 5.1 绝对(包内相对)链接

以 `/` 开头,相对于包根目录解释。

```markdown
See the [customers table](/tables/customers.md) for the join key.
```

这是**推荐**形式,因为当文档在其子目录内移动时,它依然稳定。

### 5.2 相对链接

标准 Markdown 相对路径。

```markdown
See the [neighboring concept](./other.md).
```

### 5.3 链接语义

从概念 A 到概念 B 的一个链接,断言了一种**关系**。这种关系的具体种类(父/子、引用、与之关联、依赖于,等等)由**周围的散文**表达,而非由链接本身表达。构建图谱视图的消费者,通常把所有链接都当作一种"无类型关系"的有向边。

消费者**必须**容忍坏链接——目标不在包内的链接并不算格式错误,它可能只是表示"尚未写出的知识"。

> 🧭 **留白提示:** 链接是**无类型**的——机器无法从链接本身分辨"关联"还是"依赖",得靠 NLP 啃正文。这是规范刻意的取舍,也是图谱类消费者的一处硬伤,值得提"有类型链接"的扩展讨论。

---

## 6. 索引文件

`index.md` 文件**可以**出现在任意目录,包括包根目录。它枚举目录内容,以支持**渐进式展开(progressive disclosure)**——让人或智能体在打开单个文档前,先看到有哪些东西可用。

索引文件不含头信息。正文用一个或多个章节,每个章节把概念归在一个标题下:

```markdown
# Section / Group Heading

* [Title 1](relative-url-1) - short description of item 1
* [Title 2](relative-url-2) - short description of item 2

# Another Section

* [Subdirectory](subdir/) - short description of the subdirectory
```

条目**应当**带上所链概念头信息里的 description。生产者**可以**自动生成 `index.md`;消费者在没有时**可以**临场合成一个。

---

## 7. 日志文件(可选)

`log.md` 文件**可以**出现在层级的任意一层,用来记录该范围内的变更历史。格式是一个按日期分组、最新在前的扁平列表:

```markdown
# Directory Update Log

## 2026-05-22

* **Update**: Added new BigQuery table reference for [Customer Metrics](/tables/customer-metrics.md).
* **Creation**: Established the [Dataplex Playbook](/playbooks/dataplex.md).

## 2026-05-15

* **Initialization**: Created foundational directory structure.
* **Update**: Added progressive-disclosure guidelines to the root [index](/index.md).
```

日期标题**必须**用 ISO 8601 的 `YYYY-MM-DD` 形式。日志条目是散文;开头加粗的词(`**Update**`、`**Creation**`、`**Deprecation**` 等)是约定,不是要求。

---

## 8. 引用

当一个概念的正文做出源自外部材料的论断时,这些来源**应当**列在文档底部的 `# Citations` 标题下,并编号:

```markdown
# Citations

[1] [BigQuery public dataset announcement](https://cloud.google.com/blog/products/data-analytics/...)
[2] [Internal data quality runbook](https://wiki.acme.internal/data/quality)
```

引用链接**可以**是绝对 URL、包内相对路径,或指向 `references/` 子目录的路径——后者把外部材料镜像为一等的 OKF 概念。

---

## 9. 符合性

一个包**符合** OKF v0.1,当且仅当:

1. 目录树中每个非保留的 `.md` 文件,都含有一个可解析的 YAML 头信息块。
2. 每个头信息块都含有一个非空的 `type` 字段。
3. 每个保留文件名(`index.md`、`log.md`)在出现时,分别遵循 §6 与 §7 所述结构。

消费者**应当**把其他所有约束都视为软性指引。特别地,消费者**绝不可**因为以下原因拒绝一个包:

- 缺少可选头信息字段。
- 未知的 `type` 取值。
- 未知的额外头信息键。
- 坏的交叉链接。
- 缺少 `index.md` 文件。

这种宽容的消费模型是刻意为之:OKF 意在让包随着增长、重构、被智能体部分生成的过程中,始终保持可用。

> 🧭 **这就是全部硬要求。** 整份规范真正的 MUST,核心就上面三条(其中 1、2 是产出门槛,3 仅在文件存在时适用)。门槛几乎为零——任何带 `type` 的 md 都合规。**互操作靠的是约定与作品质量,而非校验器。**

---

## 10. 与其他格式的关系

OKF 刻意地贴近若干已有模式:

- **LLM "维基" 仓库**——用 Markdown + 头信息作为智能体可读的知识库。
- **个人知识工具**,如 Obsidian 和 Notion——使用带交叉链接的层级 Markdown。
- **"元数据即代码"**——把目录元数据与源代码放在一起,而非放进单独的注册表。

OKF 的主要区别在于它**被规范化了**——钉死了互操作所需的那一小套规则,同时不对工具链发号施令。

---

## 11. 版本管理

本文件规定 OKF 版本 **0.1**。未来修订将以 `<主>.<次>` 形式版本化:

- **次版本**号提升,引入向后兼容的新增内容(新的可选字段、新的约定章节标题)。
- **主版本**号提升,可能带来破坏性变更(重命名必须字段、更改保留文件名)。

包**可以**声明它面向的 OKF 版本,方式是在包根目录的 `index.md` 头信息块里写入 `okf_version: "0.1"`(这是 `index.md` 中唯一允许出现头信息的地方)。不理解所声明版本的消费者,**应当**尽力做"尽最大努力的消费",而非拒绝该包。

---

## 附录 A — 最小示例包

```
my_bundle/
├── index.md
├── datasets/
│   ├── index.md
│   └── sales.md
└── tables/
    ├── index.md
    ├── orders.md
    └── customers.md
```

`datasets/sales.md`:

```markdown
---
type: BigQuery Dataset
title: Sales
description: All sales-related tables for the retail business.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales
tags: [sales]
timestamp: 2026-05-28T00:00:00Z
---

The sales dataset contains transactional tables, including
[orders](/tables/orders.md) and [customers](/tables/customers.md).
```

`tables/orders.md`:

```markdown
---
type: BigQuery Table
title: Orders
description: One row per completed customer order.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders
tags: [sales, orders]
timestamp: 2026-05-28T00:00:00Z
---

# Schema

| Column        | Type      | Description                  |
|---------------|-----------|------------------------------|
| `order_id`    | STRING    | Unique order identifier.     |
| `customer_id` | STRING    | FK to [customers](/tables/customers.md). |
| `total_usd`   | NUMERIC   | Order total in USD.          |

Part of the [sales dataset](/datasets/sales.md).
```

---

## 中文生态议题:i18n 扩展提案草案

> 这部分不属于官方规范,是本仓库基于 §4.1"生产者可加入任意额外键"提出的、**向后兼容**的多语言约定,供讨论与向官方提案。

**问题:** OKF v0.1 没有任何"语言"概念。一份知识库若同时面向中英读者(以及中英两种消费智能体),无法表达"这是同一概念的中文版"。

**提案(作为 v0.x 次版本的可选字段):**

```yaml
---
type: BigQuery Table
title: 订单表
lang: zh                        # BCP 47 语言标签,标注本概念正文的语言
canonical: /tables/orders.md    # 指向同一概念的"主语言"版本(概念 ID)
---
```

约定:

1. `lang` — 可选字段,BCP 47 语言标签(如 `zh`、`zh-Hans`、`en`)。缺省时,消费者**应当**视为生产者未声明语言。
2. `canonical` — 可选字段,指向同一概念主语言版本的概念 ID。多语言变体彼此通过 `canonical` 收敛到同一主版本。
3. 文件组织两种皆可,生产者自选:
   - **并列文件**:`tables/orders.md`(主)与 `tables/orders.zh.md`(中文变体);
   - **并列目录**:`en/tables/orders.md` 与 `zh/tables/orders.md`。
4. 完全向后兼容:不认识 `lang`/`canonical` 的 v0.1 消费者按 §4.1 忽略未知键即可,bundle 仍然合规。

**为什么这个口子是干净的:** 它只新增可选字段,不动任何 MUST,不改保留文件名——正好落在规范 §11 定义的"次版本可做向后兼容新增"里,也正好落在官方"明确欢迎扩展提案"的邀请里。

> 配套实现:本仓库的 [`feishu-to-okf`](../plugins/feishu-to-okf/) 导出时会写入 `lang: zh`,[`okf-creator`](../skills/okf-creator/) Skill 也内置这套约定。即"提案 + 参考实现"一起出。
