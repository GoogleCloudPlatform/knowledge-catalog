# EntryLinks Feature

This feature adds support for EntryLinks to the `kcmd` tool, allowing for bi-directional synchronization of linkages between entries in Dataplex.

## Key Capabilities
- **Pull Synchronization**: Fetches EntryLinks from Dataplex and saves them in the local YAML metadata.
- **Push Synchronization**: Publishes local EntryLinks back to Dataplex, including creation and deletion of links.
- **Schema-Inlined Links**: Supports links associated with specific columns/fields within an entry's schema.
- **Dry-Run Mode**: Allows previewing sync operations without making changes.
- **Alias Resolution**: Maps fully qualified EntryLink types to human-readable aliases.
