# Design & Implementation Specification: EntryLinks Support in `kcmd`

This document defines the authoritative design and step-by-step implementation specification for adding comprehensive bi-directional synchronization and local layout support for **EntryLinks** (both top-level and schema-inlined linkages) to the `kcmd` tool. 

To ensure complete data integrity, usability, and reliability, the architecture incorporates native **data loss prevention (safe push mutations)**, dynamic **project number vs. project ID normalization**, a robust **alias resolution system (supporting both system and custom user-defined aliases)**, **selective pull filtering**, and a safe **dry-run simulation mode**.

---

## Phase 1: Core Data Models & Manifest Extension

Update the base TypeScript definitions, the manifest configuration parser, and type validation logic to cleanly handle EntryLinks and aliases.

### 1.1. Manifest Schema & Alias Support

1. **Manifest Schema Parsing:**
   * Update `manifestSchema` (Zod object) to recognize optional `aliases` or `resourceAliases` and map them dynamically.
   * Add `entryLinks` as an optional array of strings to both `snapshot` and `publishing` schemas.
   * Update interfaces `SnapshotConfig` and `PublishingConfig` to include `entryLinks?: string[]`.

2. **System and Custom Alias Registration:**
   * Add a built-in map for global/system link aliases.
   * Update the manifest class to store custom user-defined aliases loaded from `catalog.yaml`.

3. **Alias Resolution and Validation:**
   * Implement an internal type resolver helper.
