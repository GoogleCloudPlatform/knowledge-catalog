# Metadata as Code

## Overview

This document details Metadata as Code, a core Knowledge Catalog capability
designed to provide agent builders, data stewards and data producers, a source
code artifact-based UX for metadata management and context engineering. Metadata
as Code enables users and agents to author, manage, and consume metadata
artifacts using developer-friendly practices such as versioning and CI/CD as
part of their developer repository, and activate context enrichment agents on a
standardized metadata format.

This approach described in this document builds on top of broadly supported
markdown and YAML, and simple file organization structure that enables
bi-directional sync capability with Knowledge Catalog service by layering on top
of existing Import/Export capabilities, and factors in extensibility that is a
core tenet of the Catalog platform.

**High-level Plan**
We will pick a YAML representation that largely aligns with the Entry/EntryLink
+ Aspect data model in Knowledge Catalog to represent both 1st party and 3rd
party metadata. Unstructured text content in aspects will be represented as
sidecar markdown files. Local files are organized in a directory structure
aligned with the resource hierarchy of assets represented by the metadata. Users
can provide configurations to sync (download/snapshot and publish/deploy)
metadata from and to the service.

### Tenets

* **Optimized for consumption by users and agents alike.**
  Metadata as code artifacts should be easy to read and modify as well as
  naturally fit as files within a developer's repository and support use-cases
  such as versioning, diffing, CI/CD etc. In support of ease of consumption,
  users should be able to organize their metadata in logical and modular slices,
  while the layout of metadata facilitates organization and navigation.

* **Optimized for tools ecosystem**
  The code artifacts should benefit from existing IDE and tool capabilities such
  as previews, navigation, etc.

* **Enable bi-directional sync with Knowledge Catalog and metadata fidelity**
  The code artifacts should be amenable to serving as authoring and management
  source of truth. They should enable a user to fully inspect and author
  metadata that exists in the Catalog service. Metadata as code artifacts should
  be able to represent 1st and 3rd party entries, aspects and the links between
  them.

* **Embeddable and Consistent Representation**
  Users may operate on the metadata in a standalone manner in their workspace
  for example, in the context of an enrichment workflow. Alternatively, the
  metadata may be part of a larger project, such as a Dataform/DBT pipeline,
  a BigQuery semantic graph etc. We should strive for a format and
  representation that can largely be consistent across these use-cases, and be
  used independently or embedded.

### Goals

**Source artifact for agents and human-in-the-loop review workflows**
We will offer an agentic capability for metadata curation and enrichment. The
agent will operate over the code representation of metadata to read it, and
update it. Users can also track changes, review it, and if needed, directly
modify it in an interactive loop.

Metadata as Code is a pre-requisite capability to allow such agents to be built
and integrated into a standardized workflow and UX.

**Source artifact for metadata sidecars**
Similar to the above, we are also collectively building agents to streamline
building Semantic Graphs or LookML models, and Data Pipelines. These efforts are
building their use-case specific code artifacts and agent flows.

Metadata as code artifacts should naturally live within a larger project. This
allows users to work with a standard representation. It allows the enrichment
agents to be plugged into the larger agent flow as a sub-agent or agent tool.

**Context versioning**
Context engineering is central to agent building. Agent builders will need to be
able to operate on their context as source code, evolve it in a versioned
manner, and deploy it as versioned resources.

Metadata as code provides the source code UX and workflows (by virtue of being
hostable within a source control repository and using the existing versioning
capabilities). Developers can then deploy the context to co-existing deployed
versions to be able to run a/b tests and evals, and have agents pick the
appropriate version.

### Non-Goals

**Hierarchical Context Serving Store or Index**
The metadata as code model described in this document is aligned with the data
model of metadata within Knowledge Catalog that organizes metadata to mirror
resources in the integrated source systems. Specifically this means metadata
organized as Entries and EntryLinks with aspects, within an EntryGroup (both
system and user-managed) in a specific project.

Context serving or searching use-cases would benefit from a different
organization of metadata (eg. arbitrary hierarchy of content organized by data
stores, use-cases, etc.). Conceivably, we might find such hierarchies naturally
present in Document repositories such as Drive, or g3doc/wikis, or process
metadata in Knowledge Catalog to produce a serving-ready version of metadata.

## Use-cases

This is a high-level mention of some of the use-cases where Metadata-as-Code
should help with context engineering for agents.

**Knowledge Catalog Enrichment Agent**
Knowledge Catalog will offer an off-the-shelf enrichment agent that is pluggable
with user-provided instructions, skills and tools. This will allow users to plug
in their organizational data sources, including code repositories, queries,
documentation in wikis, drive etc., internal Q&A channels etc.

The enrichment agent operates on code artifacts, providing a mechanism for users
to iterate on enrichment, as well as apply human review steps, and integration
with git-based version control and CI/CD mechanisms for deployment to make the
updates live.

**Semantic Graph Business/Semantic Enrichment**
We are introducing Semantic Graphs as the mechanism for users to build semantic
models - defining entities and their relationships - that will be consumed by CA
agents to ground their behavior and resulting queries in the organizational
truth.

The graph will allow users to define entities as nodes and relationships as
edges along with additional properties, including computed values and measures.
Users will want to attach additional meaning such as glossary term definitions
as part of their graph authoring UX. Metadata-as-Code will provide a mechanism
for users to co-locate their graph definition and catalog augmentations, and
deploy them collectively.

**Metadata propagation and curation in Data Pipelines**
We are building a Data Engineering agent to streamline the creation and
productionization of data pipelines. Data engineers should be able to leverage
as well as publish metadata along with the deployment of their pipelines and
data sources and sinks. This will ensure the resulting data is more ready for
agentic consumption and allow for co-locating and unifying the UX for the
transforms and the metadata flow within a pipeline project.

**Database Context Set**
We are introducing ContextSet and related functionality (Query Templates,
Examples, etc.) to enable database admins and developers to engineer context for
their NLD and NLA agents.

This discussion is early. The observation is Metadata-as-Code offers a potential
mechanism to unify the UX for context authoring, while supporting different
service models (EntryGroup and ContextSetGroup) for purposes of storage, search
and serving.

## File Organization

Metadata is organized within a directory. The directory represents a local
snapshot of a subset of metadata in Catalog. It is the unit of synchronization
with the metadata within the service.

This directory contains a manifest file, named catalog.yaml, that provides
structured configuration that can direct tools on handling the individual
artifacts contained within the directory. It contains sub-directories that
contain individual entries and entry links.

Depending on the configured **layout** (see manifest below), files can be
organized in two ways (and potentially extendable to other layouts in future):

**Standard Layout (Default):**
```
path/to/root/
├── catalog.yaml                      # Catalog metadata, processing config/directives
└── catalog/                          # Contains all the Entries and EntryLinks
    └── <dir1>/<dir2>
        ├── <entry-id1>.yaml          # Single-file entry with all metadata contained within
        ├── <entry-id2>.yaml          # Multi-file entry with unstructured metadata split into
        └── <entry-id2>.<aspect>.md   # markdown sidecar files for unstructured aspects
```

**Wiki/KB Layout:**
```
path/to/root/
├── catalog.yaml                      # Catalog metadata, processing config/directives
└── catalog/                          # Contains all the Entries and EntryLinks
    └── <dir1>/<dir2>
        └── <entry-id1>.md            # Single markdown file: structured metadata in
                                      # frontmatter, Overview in body
```

**NOTE: IDE Workspace**
An IDE workspace, like the one in Antigravity, can include one or more such
directories, organized according to the user's preferences.

### Manifest - Catalog.yaml

The manifest file captures all configuration related information. This includes:

* The resource that the metadata snapshot corresponds to. This resource can
  either be a resource identified in a source system such as BigQuery (e.g. a
  Dataset, or a set of Tables, whose metadata is managed in Catalog in a system
  EntryGroup, such as @bigquery), or a user-managed EntryGroup containing user
  created entries.

* The physical layout of the catalog snapshot on disk (either `standard` or `wiki`).

* A set of type aliases to make it easy to refer to various catalog constructs
 such as entry-types, aspect-types, link-types, glossaries, glossary-terms, etc.

* The type of entries, aspects, and links to include into the local snapshot
  when downloading metadata from the service.

* The subset of entries, aspects, and links to publish back to the service.

**catalog.yaml**
```
scope: <type>.<name>              # The resources in the snapshot. Examples:
                                  # scope: entryGroup.<projectId>.<locationId>.<entryGroupId>
                                  # scope: bq-dataset.<projectId>.<datasetId>
                                  # Or multiple BigQuery datasets in array list format:
                                  # scope:
                                  #   - bq-dataset.<projectId>.<datasetId1>
                                  #   - bq-dataset.<projectId>.<datasetId2>

layout: standard                  # Optional. The disk layout style. Options: standard, wiki.
                                  # Defaults to standard.

aliases:                          # Optional. Can always use 3-part fully qualified references.
                                  # NOTE: All built-in types have predefined simple aliases.
  ca-guidelines:
    aspect: data-agents-project.global.ca-guidelines
  ecommerce:
    glossary: data-gov-project.global.ecommerce-glossary

# Defines the specific metadata to be retrieved locally from Knowledge Catalog.
# NOTE: Required aspects of listed entry types are implicitly included.
snapshot:
  entries:
  - bigquery-dataset
  - bigquery-table
  aspects:
  - overview
  - descriptions
  - queries
  - ca-guidelines
  entryLinks:
  - definition

# Optional configuration to identify which types should be published.
# This must be a subset of the types specified in the snapshot configuration.
publishing:
  entries:
  aspects:
  - ca-guidelines
  entryLinks:
  - definition
```

**NOTE: Type References**
Metadata content has several references to either the meta-model resources
(entry, aspect, and link types) or other catalog constructs (such as
glossaries). Syntax is provided to streamline these references.

* References take the form of `<projectId>.<locationId>.<resourceId>`. There is
  no need for referring to the verbose collection names themselves
  (projects/<projectId>/locations/<locationId>/<collection>/<resourceId>)
* Aliases can be defined to create single identifier names that are resolved
  when metadata is processed.
  * These are optional. Users can choose to use the fully-qualified references
    if that is the preference.
  * All built-in Dataplex types have pre-defined aliases without requiring the
    user to declare them. Eg. bigquery-table resolves to
    dataplex-types.global.bigquery-table.
* Use project IDs, not project numbers when generating metadata.

### Entry File Names

The name of the file is used to identify the Entry uniquely. The following rules
are followed to derive file names from EntryIds.

**Ingested Entries** use the service-qualified full resource name as EntryId.
Inferrable segments (Service name and Location from EntryGroup) and Collection
names (where possible) will be stripped out.

| bigquery.googleapis.com/ projects/projectId/ datasets/datasetId/ tables/tableId | projectId.datasetId/tableId.yaml | Aligns with physical hierarchy. Common case for context use-cases. Avoid a type segment in directory path to optimize for most common resource when a collection has multiple types of sub-resources |
| bigquery.googleapis.com/ projects/projectId/ datasets/datasetId/ routines/routineId | routines/projectId.datasetId/routineId.yaml | Moved into sub-directory to avoid potential conflicts between table and routine names |
| cloudsql.googleapis.com/ projects/projectId/ locations/locationId/ instances/instanceId/ databases/databaseId | instanceId/databaseId/tableId.yaml | Example included to demonstrate how EntryIds and corresponding file names treat control plane and dataplane ids together |


**3rd party Custom Entries** may use a similar REST API name of the resource
(recommended when applicable) or arbitrary path-identifier (more likely
scenario); We align the metadata file path to the Entry Id as there are no
conventions to apply here.

| Entry Id | File Path | NOTES |
| :---- | :---- | :---- |
| hive.walmart.com/ services/serviceId/ databases/databaseId/ tables/tableId | hive.walmart.com/ services/serviceId/ databases/databaseId/ tables/tableId.yaml |  |
| name-part1/name-part2 | name-part1/name-part2.yaml | Likely the common pattern for custom context overlays and bundles. We ensure that it is clean in directory layout. |
| simple-name | simple-name.yaml |  |

### File Extensions

* **Standard Layout**: Entry files use the `.yaml` extension (e.g., `tableId.yaml`),
with unstructured aspects optionally stored in sidecar `.md` files
(e.g., `tableId.overview.md`).

* **Markdown-only Layout**: Entry files use the `.md` extension (e.g., `tableId.md`),
where the main YAML entry is replaced with a single markdown file containing YAML
frontmatter and the promoted unstructured aspect (`Overview.content`) as its body.

### Entry File Layouts

Metadata files are primarily structured representations of entry catalog info and
aspects. Depending on the selected layout, the organization of these files differs:

* **Standard Layout (YAML + Markdown sidecars)**: Every entry is represented by at
least a single YAML file (`<entry-id>.yaml`) that captures entry metadata,
information about associated resource, and all aspects and links. Aspects containing
unstructured rich-text fields (like `overview`) are split into sidecar markdown files
(e.g., `<entry-id>.overview.md`).

* **Wiki Layout (Markdown Only)**: The main YAML file is replaced with a single markdown file
(`<entry-id>.md`). The structured YAML metadata moves entirely to the
YAML frontmatter of this markdown file, and the unstructured text of the
`overview.content` aspect becomes the main markdown body of the file.

#### Standard Layout

**Entry Resource Info + Entry Source + Aspects (`entry.yaml`)**
```yaml
id: <id>                                # Entry metadata
type: <entryType>
resource:                               # Entry.EntrySource
  name: <entrySource.name>
  displayName: <entrySource.displayName>
  description: <entrySource.description>
  labels:
    key: value
  location: <entrySource.location>
  parent: <entry.parent>
  ancestors: <entrySource.ancestors>
  createTime: <entrySource.createTime>
  updateTime: <entrySource.updateTime>

schema:
  fields:
  - name1: <schemaField.name>
    dataType: <schemaField.dataType>
    mode: <schemaField.mode>
    …
    links:                              # EntryLinks associated with Schema.path are inlined
      definition:                       # into a Schema field to leverage context of field
      - target: glossary.term           # specification

<aspect-type>:                          # In the general-case, each top-level field is an
  [aspect.data]                         # aspect. Nested field represents aspect.data

links:                                  # EntryLinks with this entry as source listed here
  <entryLink-type>:
  - target: <target-entry-reference>
    <aspect-type>:
      [aspect.data]
```

**Sidecar File per Aspect with Unstructured Text (`entry.overview.md`)**
```markdown
---
field: value                            # YAML frontmatter used to capture structured metadata
---
[aspect.data.rich-text-field]
```

#### Wiki Layout

In the wiki layout, the YAML content is placed in the YAML frontmatter
of a `.md` file, and the unstructured overview text (`overview.content`) is
promoted to the markdown body.

**Entry with Inlined Unstructured Text (`entry.md`)**
```markdown
---
id: <id>                                # Entry metadata in frontmatter
type: <entryType>
resource:                               # Entry.EntrySource
  name: <entrySource.name>
  displayName: <entrySource.displayName>
  description: <entrySource.description>
  labels:
    key: value
  location: <entrySource.location>
  parent: <entry.parent>
  ancestors: <entrySource.ancestors>
  createTime: <entrySource.createTime>
  updateTime: <entrySource.updateTime>

schema:
  fields:
  - name1: <schemaField.name>
    dataType: <schemaField.dataType>
    mode: <schemaField.mode>
    …
    links:
      definition:
      - target: glossary.term

<aspect-type>:                          # Other structured aspects
  [aspect.data]

overview:                               # Unstructured aspect's metadata
  userManaged: true
  links:
  - title: <title>
    url: <url>

links:                                  # EntryLinks with this entry as source
  <entryLink-type>:
  - target: <target-entry-reference>
    <aspect-type>:
      [aspect.data]
---
# <displayName or entry-id>

This is the main markdown body representing `overview.content` aspect data.
```

## Examples

### Enrichment Agent

This is an example for a BigQuery dataset and a table. For purposes of
illustration, the user is interested in working the metadata that is used in
Conversational Analytics, to enrich Overview documentation, Generated
descriptions, Suggested Queries, Agent Guidelines and Glossary associations, and
publish them back to Knowledge Catalog.

**workspace/catalog.yaml**
```
scope: bq-dataset.ecommerce-prod.ecommerce-dataset

resourceAliases:
  guidelines:
    aspect: data-agents-project.global.guidelines
  ecommerce:
    glossary: data-gov-project.global.ecommerce-glossary

snapshot:
  entries:
  - bigquery-dataset
  - bigquery-table
  aspects:
  - overview
  - descriptions
  - queries
  - guidelines
  - data-profile            # Included as local context, but not published
  - query-usage             # Same as above
  entryLinks:
  - definition

publishing:
  aspects:
  - overview
  - descriptions
  - queries
  - guidelines
  entryLinks:
  - definition
```

**workspace/catalog/ecommerce-prod.ecommerce-dataset.yaml**
```
id: bigquery.googleapis.com/projects/ecommerce-prod/datasets/ecommerce-dataset
type: bigquery-dataset
createTime: <createTime>
updateTime: <updateTime>

resource:
  name: projects/ecommerce-prod/datasets/ecommerce-dataset
  displayName: E-commerce Production Dataset
  description: ...
  labels:
    env: prod
  createTime: <entrySource.createTime>
  updateTime: <entrySource.updateTime>

bigquery-dataset:
  ...

descriptions:
  description: <generated dataset description>
```

**workspace/catalog/ecommerce-prod.ecommerce-dataset/orders.yaml**
```
id: bigquery.googleapis.com/projects/ecommerce-prod/datasets/ecommerce-dataset/tables/orders
type: bigquery-table
createTime: <createTime>
updateTime: <updateTime>

resource:
  name: projects/ecommerce-prod/datasets/ecommerce-dataset/tables/orders
  displayName: E-commerce Orders
  description: ...
  labels:
    env: prod
  createTime: <entrySource.createTime>
  updateTime: <entrySource.updateTime>

bigquery-table:
  ...
storage:
  ...

schema:
  fields:
  - name: id
    dataType: string
    mode: required
    links:
      definition:
      - target: ecommerce.order-number
  - name: status
    dataType: integer
    mode: required

dataProfile:
  [data-profile-data]

queryUsage:
  [top-fields and other usage aggregations]

descriptions:
  description: <generated table description>
  fields:
  - name: id
    description: ...
  - name: status
    description: ...

queries:
  queries:
  - description: ...
    sql: |
      [SQL Text]

links:
  definition:
    target: ecommerce.transaction
```

**workspace/catalog/ecommerce-prod.ecommerce-dataset/orders.overview.md**
```
---
userManaged: true
links:
- title: <title>
  url: <url>
---
[overview.content]
```

**workspace/catalog/ecommerce-prod.ecommerce-dataset/orders.guidelines.md**
```markdown
---
userManaged: false
---
[guidelines.instructions]
```

### Wiki Knowledge Base

Assume the user is managing a knowledge base of information managed in a hierarchical
structure. Or alternatively, an agent is building this knowledge base from previously
aggregated or enriched metadata.

**wiki/catalog.yaml**
```yaml
scope: entryGroup.ecommerce-prod.global.wiki
layout: wiki             # Configured to use wiki layout

snapshot:
  entries:
  - document
  aspects:
  - overview

publishing:
  aspects:
  - overview
```

**wiki/catalog/products.md**
```markdown
---
id: products
type: document
createTime: <createTime>
updateTime: <updateTime>

resource:
  name: products
  displayName: Wiki Produc  ts
  description: ...
---
# Products Data

This is the markdown body representing `overview.content` for the document.
```

**workspace/catalog/playbooks/mbr.md**
```markdown
---
id: playbooks/mbr
type: document

resource:
  name: playbooks/mbr
  displayName: MBR Playbook
  description: ...
---
# Ecommerce Monthly Business Review Playbook

[overview.content]
```
