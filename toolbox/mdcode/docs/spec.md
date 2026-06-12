# Metadata as Code Specification

This specification builds upon the concepts in `docs/concept.md` and
`readme.md`, detailing the agreed-upon design decisions, critical user journeys,
glossary, and test cases for the Metadata as Code project.

## 1. Overview

Metadata as Code provides a source code artifact-based UX for metadata
management and context engineering in Knowledge Catalog (Dataplex). It is
designed for agent builders, data stewards, data producers, and AI agents to
author, manage, and enrich metadata using developer-friendly workflows with
version control and CI/CD.

### 1.1. Primary Use Case

The primary driver for the initial design is the **Knowledge Catalog Enrichment
Agent**, focusing on automating metadata curation with human-in-the-loop review.
However, the library is designed to be flexible and usable by any developer
building agents or custom tools.

## 2. Glossary of Terms

To ensure consistency, the following terms are used:

*   **Catalog Snapshot**: A directory on the local filesystem containing a
    subset of Knowledge Catalog metadata.
*   **Manifest (catalog.yaml)**: A file in the snapshot root that captures sync
    configuration and directives.
*   **Scope**: A unified identifier format (`<type>.<name>`) that establishes
    the single target resource for the snapshot in the manifest.
*   **Standard Layout**: A hybrid disk organization automatically used for
    `bq-dataset` and `entryGroup` scopes where metadata structure is stored in a
    YAML file per entry, and unstructured aspects are placed in sidecar Markdown
    files.
*   **Documents Layout**: A Markdown-only disk organization automatically used
    for `kb` scopes where the main entry is represented as a single Markdown
    file, with metadata structured in the YAML frontmatter and the main overview
    aspect promoted to the Markdown body.
*   **Entry**: A representation of a resource (like a table or dataset) in the
    Knowledge Catalog.
*   **Aspect**: A specific type of metadata attached to an entry (e.g.,
    description, profile).
*   **Sidecar File**: An auxiliary file (e.g., Markdown) used for aspects with
    unstructured text.
*   **Source**: A backend metadata repository referenced by a scope (e.g.,
    Dataplex EntryGroup or BigQuery Dataset).

## 3. Key Design Decisions

The following core decisions have been established:

### 3.1. Metadata Representation

The disk organization layout is automatically determined by the scope type:

*   **Standard Layout** (used for `bq-dataset` and `entryGroup` scopes):
    Structured data (entry metadata, resource info, aspects like schema and
    profile) is stored in a main YAML file per entry, while unstructured
    rich-text fields (like Overview) are stored in dedicated sidecar Markdown
    files.
*   **Documents Layout** (used for `kb` scopes): Structured metadata is stored
    within the YAML frontmatter of a single `.md` file per entry, and the
    primary unstructured aspect (`overview.content`) is promoted to serve as the
    main Markdown body of that file. Other unstructured aspects may still use
    sidecars.

### 3.2. Synchronization Model

We will support a bi-directional sync (Pull and Push) with the following rules:

*   **Publishing is a subset** of the snapshot list.
*   While required aspects may be implicitly included in the snapshot, all entry
    types and aspect types that should be published **must be explicitly
    listed** in the manifest.

### 3.3. Conflict Handling

To prevent data loss during a `push` operation:

*   The tool will **fail fast** if it detects that the metadata has been
    modified in the catalog in the interim.
*   It will abort the push, report the conflict, and require a `pull` to
    resolve.
*   A **force override** option will be provided to bypass this check if
    necessary.

### 3.4. Aliases Strategy

To maintain consistency and steer users toward simpler names:

*   If an alias is defined in `catalog.yaml`, it **must be used consistently**
    in metadata files.
*   Otherwise, the full reference takes the form of
    `<projectId>.<locationId>.<resourceId>`.

### 3.5. Scale and Performance

*   **Paginated Pull**: Pull operations will be paginated to handle large
    resources.
*   **Individual Push**: Push operations will be performed individually per
    entry for now, with bulk import operations considered later.
*   **Scale Assumption**: Users are managing this as code artifacts in a
    repository and should not be operating at hyperscale/unbounded scale in this
    workflow.

### 3.6. Extensibility and Validation

*   **Dynamic Schema Fetching**: The tool will fetch type definitions from the
    Catalog service dynamically to validate local files against the actual
    registered schema.

### 3.7. Checksum Storage

*   **Separate State File**: Checksums for entries and aspects will be stored in
    a separate state file (e.g., `.catalog.state`) to separate user content from
    tool state.

### 3.8. Sync Deletions

*   **Intent to Delete**: If an entry type is listed in the publish config,
    treat missing files compared to state as intent to delete.
*   **Skip for Managed Entries**: Deletions are skipped for Dataplex managed
    entries (like BigQuery resources) which cannot be deleted.

### 3.9. Unified Scope Mapping

*   **Single String Identifier**: Snapshot resources are specified using a
    unified `scope` property formatted as `<type>.<name>` (e.g.
    `bq-dataset.<id>` or `entryGroup.<id>`). This unifies target definition
    logic and enables future extension to other resource types easily.

## 4. Critical User Journeys (CUJs)

We focus on the following core journeys:

*   **CUJ 1: Initial Setup and Snapshot Creation** User runs `kcmd init` to
    create a local snapshot of a BigQuery dataset or Dataplex EntryGroup.
*   **CUJ 2: Metadata Sync (Pull and Push)** User pulls updates from the catalog
    service, makes modifications to local files, and pushes changes back to the
    catalog.

*Note: Advanced workflows like Automated Curation with Human Review (CUJ 3
candidates) are built on top of this foundation using external tools (IDE, git,
custom agents) and are out of scope for this base library.*

## 5. Key Test Cases

To validate the design, we will implement test cases covering the following
areas, including user feedback:

### 5.1. Resource Types

*   **Snapshots for different resource types**: BigQuery datasets and Dataplex
    EntryGroups.
*   **Entry and aspect varieties**: Both Dataplex-defined entries/aspects (where
    required aspects are read-only) and user-defined ones (where required
    aspects are modifiable).

### 5.2. Format Mapping

*   **Standard Layout** (for `bq-dataset` and `entryGroup` scopes): Aspects
    managed correctly within the main YAML file, and unstructured text mapped
    correctly to/from sidecar Markdown files.
*   **Documents Layout** (for `kb` scopes): Metadata mapped correctly to/from
    YAML frontmatter, and the `overview.content` aspect promoted to/from the
    Markdown file body.

### 5.3. Directory Organization

*   **BQ Resource Hierarchy**: Testing layout for BigQuery datasets.
*   **EntryGroup Hierarchy**: Testing layout for EntryGroups based on path
    segments in the entry ID.

### 5.4. Data Integrity

*   **Checksum validation**: Verifying that checksums are updated and validated
    for entries and aspects during both pull and push operations to detect
    conflicts.
