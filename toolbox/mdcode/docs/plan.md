# Phased Delivery Plan

This document outlines the phased delivery plan for building the Metadata as
Code foundation.

## Phase 1: MVP - Read-Only Snapshot & Consumption

Establish the local file structure by pulling metadata using the TypeScript
library, and enable reading that snapshot via MCP. Support early distribution.

*   **Key Features & Work:**
    *   **Library (TS)**: Fetch metadata for a BigQuery dataset or Dataplex
        EntryGroup; create local directory structure mirroring the resource
        hierarchy; generate main YAML file per entry (Standard layout);
        paginated pull; ADC authentication.
    *   **CLI (TS-based)**: Implement `kcmd init` and a basic read-only `kcmd
        pull`.
    *   **MCP (TS-based)**: Implement an MCP server with tools: `list-entries`
        and `lookup-entry` (reading from the local snapshot).
    *   **Distribution**: Support installation from source repository or local
        package for early access.
    *   **Testing**: Implement test cases for snapshot creation and directory
        layout for BigQuery datasets and EntryGroups.

## Phase 2: MVP - Basic Push (Publish)

Complete the bi-directional sync by enabling local modifications to be pushed
back to the catalog using the TypeScript library.

*   **Key Features & Work:**
    *   **Library (TS)**: Read local YAML files and reconstruct API payloads;
        push updates individually per entry; support parsing and filtering via
        `publishing` configuration in `catalog.yaml`.
    *   **CLI (TS-based)**: Implement a basic `kcmd push`.
    *   **Distribution**: Update early access packages with push capability.
    *   **Testing**: Implement test cases for basic push operation and
        publishing configuration filtering.

## Phase 3: Enhanced Representation

Optimize the file format for human and agent editing. Update interfaces to
support the new formats and layout options.

*   **Key Features & Work:**
    *   **Library (TS)**: Support `kb` scope type alongside `bq-dataset` and
        `entryGroup` in `catalog.yaml`; implement the `CatalogLayout`
        abstraction (`layout.ts`) and its concrete layouts (`StandardLayout` and
        `DocumentsLayout`); refactor `CatalogSnapshot` to delegate filesystem
        list, read, and write operations to the active layout strategy
        (automatically instantiated based on the scope); support type aliases in
        `catalog.yaml`, including built-in aliases for built-in types.
    *   **CLI (TS-based)**: Update `pull` and `push` operations to handle
        sidecars, aliases, and different layout scopes correctly.
    *   **MCP (TS-based)**: Ensure `list-entries` and `lookup-entry` tools
        correctly handle layouts (by delegating via `CatalogSnapshot` to
        `CatalogLayout` strategy).
    *   **Testing**: Implement test cases for format mapping, including Standard
        layout (YAML + sidecars) and Documents layout (Markdown + frontmatter),
        and validate that `CatalogSnapshot` interacts correctly with both
        layouts based on the active scope type. Implement test cases for
        aliases.

## Phase 4: Robust Sync and State Management

Ensure data integrity and efficient updates.

*   **Key Features & Work:**
    *   **Library (TS)**: Store checksums of local state in a separate file; use
        checksums to detect changes; treat missing files as intent to delete;
        fail fast on remote modification; fetch type definitions dynamically for
        validation.
    *   **CLI (TS-based)**: Add `kcmd status` to check for local modifications;
        update `kcmd push` to use checksums and report conflicts; support
        **force override** flag; implement `--dry-run` option for `pull` and
        `push` commands.
    *   **Testing**: Implement test cases for checksum validation, intent to
        delete, validation against dynamic schema, and `--dry-run` behavior.

## Phase 5: Future / Other

Other workstreams to consider.

*   **Key Features & Work:**
    *   **Library (TS)**: Support for EntryLinks
    *   **Python Library**: Implement the equivalent library in Python to
        support Python-based agents and workflows.
    *   **MCP (TS-based)**: Implement `pull` and `push` tools in the MCP server.
