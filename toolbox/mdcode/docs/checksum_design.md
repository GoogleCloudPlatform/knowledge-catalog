# Change Detection & Conflict Resolution Design Spec

This document outlines the design for local change detection and remote conflict resolution in the **Metadata as Code** library.

---

## Architecture Overview

To enable offline capabilities, minimal network updates, and robust conflict detection without cluttering the user's source files, the tool maintains a system-managed state database at the root of the workspace.

### Design Goals
* **Local Change Detection**: Swiftly isolates fields or aspects modified locally since the last `pull` or `push`.
* **Minimizing Network Footprint**: Only transmits aspects that have changed locally, omitting unmodified metadata.
* **Zero-Workspace Clutter**: System revisions, sync timestamps, and base checksums are stored entirely in the state database, keeping authorable source YAML/Markdown files clean for Git history.

---

## Conflict Resolution

A **conflict** occurs when there are changes made to both the local and catalog copies of the same resource metadata since the last sync.

In the event of a conflict, the resolution options depend on the direction of synchronization:

### Pull Operation Choices
* **Manual Merge**: Back up local modifications, run a force pull (`kcmd pull --force`) to fetch remote changes, and manually merge the desired local changes.
* **Abandon Local Changes**: Run a force pull (`kcmd pull --force`) to discard local modifications and align completely with the remote Catalog state.

### Push Operation Choices
* **Manual Resolution**: Back up local modifications, run a force pull (`kcmd pull --force`) to retrieve remote updates, manually merge and apply local changes, and push again.
* **Force Update**: Run a force push (`kcmd push --force`) to overwrite the remote Catalog state with the local workspace state.

The synchronization behaviors and conflict resolutions are split below into operations impacting pull and push workflows.

### 1. Pull Conflict Resolution Matrix

During a `pull` operation, the main objective is to bring remote changes into the local workspace. To protect unpushed work, the standard `pull` command implements a strict "dirty guard" check on the entire workspace first.

| Local Aspect State | Remote Aspect State | Standard Pull (`kcmd pull`) | Force Pull (`kcmd pull --force`) | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Unchanged** | **Unchanged** | **Skip** | **Skip** | No changes on either side. |
| **Unchanged** | **Modified** | **Safe to Pull** | **Safe to Pull** | Remote modifications are safely written to the local workspace. |
| **Unchanged** | **Deleted** | **Safe to Delete Locally** | **Safe to Delete Locally** | Remote deletion is propagated locally; the local aspect file is deleted. |
| **Does Not Exist** | **Exists Remotely** | **Safe to Pull** | **Safe to Pull** | The remote aspect is pulled down and created in the local workspace. |
| **Modified** / **Created** / **Deleted** | **Any State** | **Abort (Dirty Workspace)** | **Overwritten by Remote** | Local changes exist in the workspace. Standard pull aborts immediately to prevent overwriting unpushed local work. Force pull discards local changes and overwrites them with the remote state. |

### 2. Push Conflict Resolution Matrix

During a `push` operation, local modifications are sent to the remote catalog. A standard `push` will abort if any conflict is detected (i.e., if the remote state has changed since the last synchronization).

| Local Aspect State | Remote Aspect State | Standard Push (`kcmd push`) | Force Push (`kcmd push --force`) | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Unchanged** | **Unchanged** | **Skip** | **Skip** | No changes on either side. |
| **Unchanged** | **Modified** | **Skip** | **Skip** | No local changes to push. Remote changes remain until the next pull. |
| **Modified** | **Unchanged** | **Safe to Push** | **Safe to Push** | Pushes local modifications to the remote catalog. Base checksum is updated. |
| **Modified** | **Modified** | **Conflict (Abort)** | **Force Overwrite** | Both copies were modified. Standard push aborts. Force push overwrites the remote aspect. |
| **Modified** | **Deleted (Entry Deleted)** | **Conflict (Abort)** | **Force Create/Overwrite** | The remote entry itself was deleted. Force push recreates the entry and aspect on the remote. |
| **Modified** | **Deleted (Aspect Deleted)** | **Conflict (Abort)** | **Force Create/Overwrite** | The remote aspect was deleted. Force push recreates/updates the aspect on the remote. |
| **Deleted** | **Unchanged** | **Safe to Delete Remotely** | **Safe to Delete Remotely** | Pushes the aspect deletion to the remote catalog. Base state is cleaned up. |
| **Deleted** | **Modified** | **Conflict (Abort)** | **Force Delete Remotely** | The aspect was modified remotely while being deleted locally. Force push deletes the aspect remotely. |
| **Deleted** | **Deleted** | **Skip** | **Skip** | The aspect was deleted on both sides. Local state base checksum is cleaned up. |
| **Created (New)** | **Exists Remotely** | **Conflict (Abort)** | **Force Overwrite** | Local aspect created but already exists on the remote. Force push overwrites remote aspect. |
| **Created (New)** | **Does Not Exist** | **Safe to Create** | **Safe to Create** | Pushes the new aspect to the remote catalog. Base checksum is recorded. |

---

## Design Rationale: Why a State Database is Required

To perform three-way change detection and detect conflicts safely, the sync engine must distinguish between changes made by the local user and changes made on the remote Catalog. 

If the tool only compared the **Local Workspace State** directly to the **Remote Catalog State**, it would be impossible to determine the direction of change:
* Does a mismatch mean the user modified the local file, or that someone modified the remote entry?
* Did a missing aspect locally mean the user intentionally deleted it, or that the aspect was created remotely and is missing locally?

To resolve these ambiguities without polluting the user's authorable YAML and Markdown files with system metadata (e.g., sync timestamps, revision IDs, or base checksums), the design introduces a system-managed **State Database**. 

This database acts as a local ledger storing the **Base State (Last Synchronized State)**. By comparing the base checksum of an aspect at the last sync against its current local and remote checksums, the tool can uniquely determine the source of any modifications and execute the correct action:

```mermaid
graph TD
    subgraph "Comparison States"
        Local["Local Workspace State<br/>(On User's Disk)"]
        Base["Base State<br/>(Stored in State DB)"]
        Remote["Remote Catalog State<br/>(On GCP Dataplex)"]
    end

    Local ===|1. Detect Local Edits| Base
    Base ===|2. Detect Remote Edits| Remote
    
    style Base fill:#2d3748,stroke:#3182ce,stroke-width:2px,color:#fff
```

---

## The State Database (`catalog-state.json`)

A flat JSON database maps each tracked entry and its corresponding aspects to their last synchronized state.

### Checksum Scope & Modifiability Constraints

Before discussing database layout options, we define the scope and constraints of the tracked metadata:
* **Entry-Level & Aspect-Level Checksums**: The tool tracks both a unified **Entry-Level Checksum** and individual **Aspect-Level Checksums**. This is critical for user-managed or custom entries where the entry itself can be created or deleted, and for uningested entry groups where entry-level metadata (such as `entrySource`, `displayName`, or `description`) is modifiable.
* **Aspect `checksum`**: These checksums are calculated for the key-value properties inside each individual aspect type (e.g., `dataplex-types.global.overview`, `dataplex-types.global.descriptions`).
* **Static Modifiability Enforcement**: The `catalog.yaml` validation layer statically ensures that only modifiable aspects and entry properties are configured to be synchronized and published.

### Proposed Design: Flat State File (`catalog-state.json`)

A single JSON file at the root of the workspace containing a map of all tracked entries, their unified entry-level base checksum, their last sync timestamps, and individual base aspect checksums.

> [!NOTE]
> **Why JSON over YAML for system state?**
> Since `catalog-state.json` is entirely system-managed and gitignored, human readability is secondary to execution performance and parsing reliability. Node.js has native, highly-optimized C++ support for parsing and serializing JSON (`JSON.parse` / `JSON.stringify`). Utilizing YAML would require external JavaScript-based parser libraries, which introduce significant CPU and execution latency during CLI startup as the catalog scales.

```json
{
  "version": "1",
  "entries": {
    "ecommerce-prod.ecommerce-dataset/orders": {
      "entryChecksum": "e93fa854cd329fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b857",
      "lastSyncTime": "2026-05-26T06:18:49Z",
      "aspects": {
        "dataplex-types.global.overview": "a8f5c1e39834c2219efbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "dataplex-types.global.descriptions": "5b30c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b856"
      }
    }
  }
}
```

* **Pros:**
  * **High Performance:** Native V8 JSON parsing (`JSON.parse`/`JSON.stringify`) is extremely fast and incurs zero external parsing dependency overhead.
  * **Startup Optimization / Mapping:** The state file maps entry IDs directly to their base hashes and structures. This acts as an in-memory catalog index, allowing the startup phase to construct a map of the local catalog's content without recursively enumerating, scanning, and parsing every file in the workspace directory.
  * **Derivable File Paths:** File locations and formats are derived from entry names based on the `CatalogSource` and `CatalogLayout` implementations, allowing the state file to omit `format` and `file` fields for a highly compact representation.
  * **Zero Clutter:** Keeps the user's active catalog folders completely clean of system-managed state files.
* **Cons:**
  * **State Desynchronization & Atomicity Risk:** Storing authorable metadata in the `catalog/` directory and its base sync state in `catalog-state.json` separates the data from its tracking ledger. Because writing to two separate files cannot be executed as a single atomic OS transaction, any process interruption (such as a crash, manual cancel, or disk-full error) in between operations can leave the workspace in an inconsistent state. This requires the CLI tool to implement strict write-ordering sequences or write-ahead journaling to detect and self-heal inconsistencies.
  * **Global Write Amplification:** Every single metadata modification, creation, or deletion—even to a single aspect or description—requires the CLI to read, deserialize, modify, reserialize, and rewrite the *entire* centralized `catalog-state.json` database. At a large catalog scale, this introduces massive I/O overhead for minor incremental changes and creates a global execution bottleneck if multiple automated runs attempt concurrent updates.

---

### Alternatives Considered

#### Mirror State Directory (`.catalog_state/`)

A hidden directory mirroring the structure of the `catalog/` folder, containing individual aspect state files.

```
path/to/root/
├── catalog.yaml
├── catalog/
│   └── ecommerce-prod.ecommerce-dataset/
│       ├── orders.yaml
│       └── orders.overview.md
└── .catalog_state/
    └── ecommerce-prod.ecommerce-dataset/
        ├── orders.yaml.state
        └── orders.overview.md.state
```

* **Pros:**
  * Keeps the developer's source directories clean of state metadata.
  * Matches the structure of the user catalog directory exactly, making mapping straightforward.
* **Cons:**
  * **High IO Overhead:** Incurs significant directory traversal and file manipulation overhead, since Node.js must manage and keep two identical directory hierarchies in sync as the catalog scales.

#### Co-located Checksum Files (In-place)

Checksum state files are stored directly inside the catalog directories, placed immediately next to their corresponding authorable source files using a `.checksum` suffix.

```
path/to/root/
├── catalog.yaml
└── catalog/
    └── ecommerce-prod.ecommerce-dataset/
        ├── orders.yaml
        ├── orders.yaml.checksum
        ├── orders.overview.md
        └── orders.overview.md.checksum
```

* **Pros:**
  * **Self-Contained:** Highly localized. If a directory or file is renamed/deleted by the user, the corresponding checksum file can be moved or deleted concurrently by standard OS tools.
* **Cons:**
  * **High Clutter:** Doubles the number of files in the user's workspace folders, drastically reducing manual curation readability and cluttering the Git tracking space.



### Concurrent Process Locking

To prevent state database corruption when multiple instances of the `kcmd` CLI or automated runners (such as CI/CD pipelines or local agent tools) run concurrently, the tool implements a lightweight, cross-platform file lock on `catalog-state.json` during read/write sequences. If the state file is locked, concurrent operations will fail-fast with a concurrency conflict error.

> [!IMPORTANT]
> **Aspect Creations & Type Registration Constraints**
> Local creation or addition of an aspect within an entry is strictly permitted only for **existing, registered `aspectTypes`** in the Google Cloud Dataplex service. The CLI tool cannot create aspect types dynamically on the fly. The sync tool retrieves valid aspect schemas during snapshot initialization (see `_buildTypes` in `snapshot.ts`) and validates the local workspace against these schemas before executing any sync operations.

---

## Synchronization Workflows

### Pull Workflow

To prevent silent data loss, the `pull` command executes a safety "dirty guard" to verify if the user has any unpushed local modifications before writing remote catalog updates.

```mermaid
sequenceDiagram
    autonumber
    participant Tool as CLI Sync Tool
    participant Disk as Local Workspace
    participant State as State File (catalog-state.json)
    participant Remote as Knowledge Catalog

    Note over Tool: User executes "pull"
    Tool->>Disk: Read Local Workspace Files
    Tool->>State: Load Base Checksums
    Tool->>Tool: Calculate Current Local Entry Checksums
    
    Note over Tool: Optimization Layer: Check Entry Checksum First
    Tool->>Tool: Compare Entry Checksum with Base
    alt Entry Checksum Changed
        Tool->>Tool: Calculate and Compare Granular Aspect Checksums
    end
    
    alt Local Modifications Detected & No --force Flag
        Note over Tool: DIRTY WORKSPACE! Abort pull.
        Tool->>Tool: Terminate execution & notify user
    else Safe to Pull (No Local Changes OR --force used)
        Tool->>Remote: Fetch Entries (lookupEntry with CUSTOM view & catalog aspects)
        Remote-->>Tool: Return Entry JSON with Aspects

        loop For Each Entry
            Tool->>Tool: Normalize (Semantic & whitespace normalization)
            Tool->>Tool: Calculate Entry & Aspect Checksums
            Tool->>Disk: Write Sidecar Aspect/Core Files (YAML/Markdown)
            Tool->>State: Write Entry & Aspect Base Checksums
        end
    end
```

1. **Workspace Dirty Check (Pull-Safety Guard - Strict All-or-Nothing):**
   - Compute current local entry-level checksums for all catalog entries.
   - Compare each computed checksum against the `entryChecksum` in the state file.
   - For any entry where the entry-level checksum differs, perform granular checks on its individual local aspects and core fields to confirm actual modifications.
   - If *any* local change is detected anywhere in the workspace and the `--force` flag is absent, the entire pull operation aborts immediately. This strict all-or-nothing constraint protects unpushed work across the entire workspace.
   
   > [!NOTE]
   > **Why a Dirty Guard is necessary:**
   > If a user has modified local catalog files but has not yet pushed them, their workspace is considered "dirty". A standard `pull` fetches remote files and writes them directly to disk. Without the Dirty Guard, this would silently overwrite and permanently erase any unpushed local modifications.

2. **Fetch Remote State:**
   - Fetch entries (including aspects) from the remote catalog.

3. **Semantic Normalization (Semantic-Aware Checksumming):**
   A standard byte-level string hash (SHA-256) changes completely if an auto-formatter (like Prettier) re-orders object keys or toggles quotes, even if the underlying metadata remains exactly the same. To shield the sync engine from harmless formatting diffs, semantic-aware normalization ensures that the checksum strictly reflects the *semantic content* of the data.
   
   Before calculating checksums or comparing changes, the following normalization rules are applied:
   - **YAML/JSON Aspects**: Semantic data files are parsed into objects, their keys are recursively sorted alphabetically, and spacing is standardized to a single canonical format.
     - *Exception for Schema Arrays*: To preserve physical and logical database column ordering, array elements within `schema.fields` are not sorted alphabetically. Key sorting is recursively applied internally to the properties of each field object, but the array itself maintains its index order.
   - **Markdown Sidecars**: Markdown content sidecar files are normalized. The YAML frontmatter block undergoes the identical semantic normalization rules (parsing, alphabetical sorting, canonical formatting) as standard standalone YAML files. The Markdown body is stripped of trailing whitespace, and newlines are normalized (`\r\n` to `\n`).

4. **Save State:**
   - Save the normalized aspect content to disk (either in aspect YAML or sidecar `.md` files).
   - Update the computed entry-level and aspect checksums as the new **Base Checksums** in `catalog-state.json`.

---

### Push Workflow

```mermaid
sequenceDiagram
    autonumber
    participant Tool as CLI Sync Tool
    participant Disk as Local Workspace
    participant State as State File (catalog-state.json)
    participant Remote as Knowledge Catalog

    Note over Tool: User executes "push"
    Tool->>Disk: Read Local Workspace Files
    Tool->>State: Load Base Checksums
    
    Note over Tool: Optimization Layer: Check Entry Checksum First
    Tool->>Tool: Calculate Current Local Entry Checksums
    Tool->>Tool: Compare with Base Entry Checksums
    alt Entry Checksum Changed
        Tool->>Tool: Identify Granular Locally Modified/Created/Deleted Aspects & Core Fields
    end
    
    Note over Tool: Fetch Remote State: Individual Lookup
    loop For Each Entry with Modifications
        Tool->>Remote: Fetch Remote Entry (lookupEntry with CUSTOM view & catalog aspects)
        Remote-->>Tool: Return Remote Entry with aspects
    end

    loop For Each Modified Entry
        Note over Tool: Remote Checksum Comparison
        Tool->>Tool: Calculate Remote Entry Checksum
        alt Remote Entry Checksum != Base Entry Checksum
            Tool->>Tool: Perform granular aspect comparison
            alt Granular Remote Checksum != Base Checksum
                Note over Tool: CONFLICT! Remote aspect has changed.
                Tool->>Tool: Fail-fast and abort push
            end
        end

        alt No Conflicts Detected
            Tool->>Remote: Push updates (ModifyEntry/CreateEntry/DeleteEntry)
            Remote-->>Tool: Acknowledge Success
            Tool->>State: Update Base Entry & Aspect Checksums in catalog-state.json
        end
    end
```

1. **Detect Local Changes:**
   - Load local files, apply **Semantic Normalization**, and calculate the current local entry-level checksums.
   - Compare each entry-level checksum against its base in the state file.
   - For entries with different entry-level checksums, drill down to identify:
     - **Modified Aspects / Core Metadata**: Checksum differs from base checksum.
     - **Created Aspects / Core Metadata**: Exists locally but has no base checksum record.
     - **Deleted Aspects / Core Metadata**: Base checksum record exists but local representation has been deleted.

2. **Lookup-Based Fetching Strategy with `CUSTOM` View:**
   - To verify remote checksums, the tool fetches remote entry states individually using `lookupEntry`.
   - **Payload Optimization:** Requests explicitly use `view: 'CUSTOM'` and specify only the exact aspect types defined in `catalog.yaml`. This minimizes network payload size and avoids hitting response limits.
   - **Concurrency Control:** Calls are executed using a throttled concurrent request pool to prevent socket exhaustion and service-side rate limiting (HTTP 429).

3. **Verify & Push (Strict All-or-Nothing):**
   - The push operation implements a strict **all-or-nothing** integrity guard. If *any* modifiable property or aspect on *any* entry fails the conflict verification (where the Remote Checksum has changed since the last sync and differs from the Base Checksum), the entire push operation is aborted immediately. No partial updates are committed.
   - If a push is aborted due to a conflict, the developer has two options:
     1. **Force Overwrite**: Push with the `--force` flag to explicitly overwrite the remote catalog with the local state.
     2. **Manual Resolution**: The developer can backup their local modified files, pull the remote changes using `kcmd pull --force` to align the local state with the remote catalog, and then manually merge their backed-up changes before pushing again.
   - If no conflicts are found, the tool pushes the configured and modifiable aspects/metadata using `modifyEntry` (or `createEntry`/`deleteEntry`) and updates the base entry and aspect checksums in `catalog-state.json` to match.



## Dry Run (`--dry-run`) Mechanics

To allow developers to safely preview updates before applying changes to disk or remote metadata registries, both the `pull` and `push` operations support a `--dry-run` execution mode. 

During a dry run, the exact same calculation, lookup, and validation logic is executed, but all write mutations to the local disk or remote APIs are intercepted and replaced with a detailed summary report.

### 1. `kcmd pull --dry-run` Workflow
1. **Workspace Validation**: Runs the pull-safety "dirty guard" check. If the workspace contains local modifications, the dry run immediately aborts and reports a dirty workspace error.
2. **Fetch and Normalize**: Connects to the GCP Dataplex service and fetches the remote entry state and aspects matching the configured scope.
3. **Calculate and Compare**: Performs semantic normalization on the fetched metadata and compares computed entry-level and aspect checksums to the base checksums in `catalog-state.json` and the current local files.
4. **Preview Execution**: Prints a structured report of all pending changes to be synced locally:
   * **Added Aspects/Entries**: Aspects or entries present remotely but not locally.
   * **Modified Aspects/Entries**: Aspects or entry metadata whose remote content differs from the local copy.
   * **Deleted Aspects/Entries**: Aspects or entries deleted remotely but still present locally.
5. **Execution Safeguard**: **No write operations** are performed on the local workspace files or the `catalog-state.json` file.

### 2. `kcmd push --dry-run` Workflow
1. **Local Change Detection**: Scans local files, applies semantic normalization, compares entry-level checksums, and isolates locally modified, created, or deleted entries and aspects.
2. **Conflict Check**: Fetches the remote state of modified entries and checks if `Remote Checksum != Base Checksum` for any modified aspects or core metadata. 
3. **Conflict and Integrity Report**: If conflicts are detected, they are printed clearly and the preview reports that the push *would fail* due to concurrency conflicts. If no conflicts are found, the engine reports that the push is safe to execute.
4. **Preview Mutations**: Logs a detailed sequence of the planned API modifications:
   * **Entry Mutations**: Entry creations, deletions, or metadata modifications.
   * **Aspect Modifications**: Aspects to be updated.
   * **Aspect Creations**: New aspects to be added.
   * **Aspect Deletions**: Aspects to be removed.
5. **Execution Safeguard**: **No write operations** are performed on the remote Dataplex service (`modifyEntry`/`createEntry`/`deleteEntry` is not called) and `catalog-state.json` remains unchanged.

---

## Future Scope

### 1. Fine-Grained Change Isolation & Automatic Merging
To optimize synchronization workflows and prevent unnecessary blocks when editing non-overlapping metadata:
* **Publish-Scoped Dirty Checks**: If the snapshot configuration pulls aspects A, B, and C, but the publishing configuration only pushes aspects A and B, local modifications on aspect C should be isolated. The push operation for aspects A and B should proceed successfully without being blocked by the unpushed changes in aspect C.
* **Three-Way Merging of Aspects**: Implement intelligent, non-overlapping aspect-level merging during pull/push conflicts so that independent updates to distinct aspects in the same entry can merge automatically without requiring human intervention.


### 2. State File Resiliency & Atomic Writes
To prevent state file corruption when writing updates to `catalog-state.json` (e.g., if the CLI process is interrupted, crashes, or the disk runs out of space):
* **Atomic Write Mechanism**: Future versions of the CLI should implement atomic file updates. Instead of writing directly to the target `catalog-state.json` file, the tool will write the updated state to a temporary file (e.g., `catalog-state.json.tmp`) in the same directory, and then use an atomic rename operation (`fs.rename` or equivalent OS-level rename) to replace the original file.
* **Automatic Backup**: Maintain a `catalog-state.json.bak` copy before executing any state transitions to facilitate self-healing and recovery options for corrupted states.




