# Phased Delivery Plan

This document outlines the phased delivery plan for building the Metadata as Code foundation.

## Phase 1: Core Sync (Pull & Push)
Establish the local file structure and enable basic bi-directional metadata synchronization using the TypeScript library.

*   **Key Features & Work:**
    *   **Library (TS)**:
        *   Fetch metadata for a BigQuery dataset or Dataplex EntryGroup.
        *   Create local directory structure mirroring the resource hierarchy.
        *   Generate main YAML file per entry (Standard layout).
        *   Implement paginated pull.
        *   Implement ADC authentication.
        *   Read local YAML files and reconstruct API payloads.
        *   Push updates individually per entry.
        *   Support parsing and filtering via `publishing` configuration in `catalog.yaml`.
    *   **CLI (TS-based)**:
        *   Implement `kcmd init`, `kcmd pull`, and `kcmd push` commands.
    *   **Distribution**:
        *   Support installation from source repository or local package for early access.
    *   **Testing**:
        *   Implement test cases for snapshot creation and directory layout for BigQuery datasets and EntryGroups.
        *   Implement test cases for basic push operations and publishing configuration filtering.

## Phase 2: Enhanced Representation & State Management
Optimize the file format for human and agent editing. Implement layout support, multi-dataset scope, and entry links. Establish sync and state management.

*   **Key Features & Work:**
    *   **Library (TS)**:
        *   Support `standard` and `wiki` layouts.
        *   Support multi-dataset configuration for BigQuery, enabling sync of multiple datasets.
        *   Support `EntryLinks` for catalog entries.
        *   **Sync and State Management**:
            *   Store checksums of local state in a separate metadata file (e.g., `.catalog.state`).
            *   Use checksums to detect local modifications and remote drift.
            *   Treat missing local files as intent to delete corresponding remote catalog entries.
            *   Fail fast on remote modifications to prevent overwriting newer changes.
    *   **CLI (TS-based)**:
        *   Update `pull` and `push` operations to support sidecars, multi-dataset BQ and entry links.
        *   Add `kcmd status` to check for local modifications and remote drift.
        *   Update `kcmd push` to use checksums and report sync conflicts.
        *   Support a force override (`--force`) flag to bypass drift checks.
        *   Implement a dry-run (`--dry-run`) option for `pull` and `push` commands.
    *   **Testing**:
        *   Implement test cases for Standard layout (YAML + sidecars) and Documents layout (Markdown + frontmatter) format mapping.
        *   Implement test cases for multi-dataset BigQuery pulling and pushing.
        *   Implement test cases for entry links.
        *   **Sync and State Management Testing**:
            *   Implement test cases for checksum calculation and drift detection.
            *   Implement test cases for intent to delete behavior.
            *   Implement test cases for sync conflict resolution, `--force` override, and `--dry-run` behavior.

## Phase 3: Validation & Overlay Support
Ensure data integrity, dynamic validation, type aliases, creation of remote resources, overlay support.

*   **Key Features & Work:**
    *   **Validation & Aliases**:
        *   Support type aliases in `catalog.yaml`.
        *   Fetch type definitions dynamically from Catalog service for client-side schema validation.
        *   Perform client-side schema validation against dynamic schemas prior to push operations.
    *   **Overlay & Target Management**:
        *   Support Dataplex Entry Group creation if they do not exist on the remote catalog.
        *   Support pushing BigQuery metadata to a different overlay Entry Group in Dataplex rather than the source dataset directly.
    *   Support `lakehouse` `entryGroup` in `catalog.yaml` to enable Dataplex Lakehouse asset sync.
    *   **CLI (TS-based)**:
        *   Update `push` and `pull` to support aliases, and overlay entry groups.
    *   **Testing**:
        *   Comprehensive test suite for different scenarios.
        *   Implement test cases for type aliases.
        *   Implement test cases for dynamic schema fetching and schema validation.
        *   Implement test cases for creating Entry Groups and pushing to overlay Entry Groups.
        *   Implement test cases for aspect-level change detection and incremental push updates.

## Phase 4: MCP Tools & Ecosystem Integrations
Expose Metadata as Code via MCP, integrate with workflow engines, and support Python and other language ecosystems.

*   **Key Features & Work:**
    *   **MCP Tools (TS-based)**:
        *   Implement an MCP server exposing tools: `list-entries`, `lookup-entry`, `pull`, and `push` directly to agents.
    *   **Python Library**:
        *   Implement equivalent Python-based library to support Python-based workflows and agents.
        *   Maintain parity with TypeScript library for YAML structures, layouts, and checksum state management to ensure cross-language compatibility.
    *   **Dataform and other products Integration**:
        *   Develop native adapters or plugins to sync metadata directly from Dataform, DBT, or other data orchestration systems.