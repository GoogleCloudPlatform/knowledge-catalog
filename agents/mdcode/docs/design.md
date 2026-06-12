# Metadata as Code Design Specification

This document details the overall design for the Metadata as Code project,
factoring in the sub-system breakdown, API surfaces, CLI and MCP structures,
technical stack, and key technical decisions. It builds upon the initial context
provided in:

-   [readme.md](../README.md)
-   [concept.md](concept.md)
-   [spec.md](spec.md)
-   [plan.md](plan.md)

## 1. Sub-system / Module Breakdown

The system is divided into two public interface layers and a core library
foundation.

### 1.1 Public Interfaces

-   **CLI (`kcmd`)**: A single binary built using **Bun** that handles user
    interaction and parses commands using the `cac` framework.
-   **MCP Server**: Hosted within the same `kcmd` binary, triggered by the `mcp`
    command argument (e.g., `kcmd mcp`). It exposes sync operations as tools to
    external agents.

### 1.2 Core Library Foundation (`kc-mac`)

The brain of the operation, containing the following modules:

-   **`CatalogManifest`**: Handles loading, validating, and parsing the
    `catalog.yaml` project manifest, including parsing the unified `scope`
    specification (which determines the layout style).
-   **`CatalogSnapshot`**: Manages local catalog entries and coordinates
    high-level read/write/list logic by delegating physical file representation
    and layout-specific tasks to `CatalogLayout`.
-   **`CatalogLayout`**: Abstract class defining the operations to list, read,
    write, and delete files on the local disk. Standard and Wiki layouts
    implement this interface, automatically selected based on the scope type.
-   **`CatalogSync`**: Orchestrates pull and push sync directions, handles
    pagination, fail-fast conflict detection, and manages tool state in a
    separate state file (`.catalog.state`).
-   **`CatalogService`**: Wrapper for raw HTTP API calls, handling Application
    Default Credentials (ADC) auth and LRO polling.

## 2. Project Directory Structure

This section describes the directory structure for the project source code,
reflecting the merge of interfaces, TypeScript library naming for future
expansion, and the `gcp` subfolder for API functionality:

-   **`src/`**
    -   **`tool/`**: The unified layer for CLI and MCP.
    -   **`main.ts`**: The entry point for the unified binary (`kcmd`). Handles
        argument parsing to direct to either CLI commands or MCP server.
        Defines/handles CLI surface.
    -   **`commands.ts`**: Contains functionality for CLI commands.
    -   **`mcp.ts`**: Contains functionality for the MCP server and tools.
    -   **`libts/`**: The TypeScript core library.
    -   **`index.ts`**: The main entry point exporting public APIs.
    -   **`manifest.ts`**: Contains the `CatalogManifest` class logic.
    -   **`layout.ts`**: Contains the `CatalogLayout` interface.
    -   **`source.ts`**: Contains the `CatalogSource` interface.
    -   **`snapshot.ts`**: Contains the `CatalogSnapshot` class logic.
    -   **`sync.ts`**: Contains the `CatalogSync` class logic.
    -   **`gcp/`**: Subfolder for GCP-specific functionality.
        -   **`api.ts`**: Contains the `Api` base class with polling and
            retries.
        -   **`context.ts`**: Contains the `ApiContext` class.
        -   **`dataplex.ts`**: Contains the API client for Knowledge Catalog.
    -   **`sources/`**: Subfolder containing source-specific implementations.
        -   **`entrygroup.ts`**: Encapsulates behavior for Dataplex EntryGroups.
        -   **`bq-dataset.ts`**: Encapsulates behavior for BigQuery datasets.
        -   **`wiki.ts`**: Encapsulates behavior for Wikis.
    -   **`layouts/`**: Subfolder containing layout-specific implementations.
        -   **`standard.ts`**: Encapsulates behavior for Standard layout.
        -   **`documents.ts`**: Encapsulates behavior for Wiki layout.

## 3. Public API, CLI, and MCP Structure

### 2.1 Library API Surface

**`CatalogManifest`**

-   `static initWithEntryGroup(entryGroup: string, ctx: ApiContext):
    CatalogManifest`
-   `static initWithBigQuery(dataset: string, ctx: ApiContext): CatalogManifest`
-   `static initWithKB(kb: string, ctx: ApiContext): CatalogManifest`
-   `static load(path: string, ctx: ApiContext): Promise<CatalogManifest>`
-   `save(path: string): void`

**`CatalogLayout` (Abstract Class)**

-   `abstract list(snapshotPath: string): Promise<string[]>`
-   `abstract readEntry(snapshotPath: string, entryId: string): Promise<Entry>`
-   `abstract writeEntry(snapshotPath: string, entryId: string, entry: Entry):
    Promise<void>`
-   `abstract deleteEntry(snapshotPath: string, entryId: string): Promise<void>`

**`StandardLayout` (extends `CatalogLayout`)**

-   Implements filesystem storage using a main `.yaml` file per entry and
    optional sidecar `.overview.md` files for unstructured aspects.

**`WikiLayout` (extends `CatalogLayout`)**

-   Implements filesystem storage using a single `.md` file per entry with the
    metadata in the YAML frontmatter and the overview content as the markdown
    body.

**`CatalogSnapshot`**

-   `static fromPath(path: string): CatalogSnapshot`
-   `layout: CatalogLayout`: The layout strategy instance initialized based on
    the manifest scope.
-   `list(): Promise<string[]>`: Returns a list of entry IDs in the snapshot by
    delegating to `layout.list(snapshotPath)`.
-   `lookupEntry(entryId: string): Promise<Entry>`: Returns structured metadata
    for a specific entry by delegating to `layout.readEntry(snapshotPath,
    entryId)`.
-   `updateEntry(entryId: string, updates: Record<string, any>): Promise<void>`:
    Merges updates into the entry metadata and aspect values, and commits the
    result via `layout.writeEntry(snapshotPath, entryId, entry)`.
-   `createEntry(entryId: string, data: Entry): Promise<void>`: Creates an entry
    locally by delegating to `layout.writeEntry(snapshotPath, entryId, data)`.
-   `deleteEntry(entryId: string): Promise<void>`: Deletes files associated with
    the entry by delegating to `layout.deleteEntry(snapshotPath, entryId)`.

**`CatalogSync`**

-   `pull(): Promise<SyncResult>`
-   `push(options?: { force?: boolean, validateOnly?: boolean }):
    Promise<SyncResult>`
-   `validate(): Promise<ValidationResult>`: Fetches fresh definitions and
    performs pre-push validation.
-   `status(): Promise<StatusResult>`: Checks for local modifications against
    the saved checksum state.

### 2.2 CLI Command Structure (`kcmd`)

-   `kcmd init [--bigquery-dataset <id>] [--entry-group <id>] [--kb <id>]`
-   `kcmd pull [--dry-run]`
-   `kcmd push [--dry-run] [--force] [--validate-only]`
-   `kcmd status`
-   `kcmd mcp` (Triggers the MCP server)

### 2.3 MCP Tools and Params

-   **`pull`**: Params: None.
-   **`push`**: Params: `force?: boolean`.
-   **`list-entries`**: Params: None.
-   **`lookup-entry`**: Params: `entryId: string`.
-   **`update-entry`**: Params: `entryId: string`, and key/value pairs for each
    field and aspect being updated.

## 4. API Client Design & Context

### 3.1 `ApiContext` (Class)

-   `project: string`
-   `token: string`
-   `static default(): Promise<ApiContext>`: Uses `gcloud` to read project and
    token defaults.
-   `refresh(): Promise<void>`: Updates token via `gcloud auth
    print-access-token`.

### 3.2 `Api` (Base Class)

-   `constructor(endpoint: string, pathPrefix: string, context: ApiContext)`
-   **Methods**: `get`, `post`, `patch`, `delete` take relative resource names.
-   **Polishing**:
    -   Fully encapsulates Long Running Operation (LRO) polling and returns only
        the completed result or error.
    -   Implements transient error retries with exponential backoff
        (configurable defaults).
    -   Automatically calls `context.refresh()` on token expiry (401).

## 5. Technical Stack and Key Dependencies

-   **Language**: TypeScript.
-   **Runtime/Build**: **Bun** for standalone binary creation and fast startup.
-   **Frameworks & Libraries**:
    -   **CLI**: `cac` (minimal size).
    -   **Schema Validation**: `zod` (TypeScript-first).
    -   **Parsing**: `yaml`.
    -   **HTTP Client**: Native `fetch` (in Bun) or `node-fetch` fallback.

## 6. Key Technical Decisions

1.  **Bun Unified Binary**: The CLI and MCP server will be distributed as the
    same single binary to reduce complexity for the end-user.
2.  **Thin HTTP Client**: We use native raw HTTP requests rather than Google
    SDKs to control code execution path and support environment workarounds.
3.  **Validation Before Action**: Fresh type definitions are pulled at
    publishing time, and full validation completes *before* the first change
    payload hits the cloud.
4.  **Fail-Fast Overwrites**: Overwrite protection fails fast when remote drift
    is identified.
