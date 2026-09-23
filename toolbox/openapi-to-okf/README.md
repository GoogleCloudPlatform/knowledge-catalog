# openapi-to-okf

Turn any OpenAPI 3.x description into a conformant Open Knowledge Format
(OKF v0.1) bundle. Dependency-free Node, no build step.

## Why

OpenAPI is the most widely published API description format. This producer lets
any service expose its existing API catalog as agent-readable OKF knowledge with
no hand-authoring, which grows the producer side of the ecosystem (see the OKF
README: "export pipelines from existing catalogs ... or scripts walking a
database").

## Usage

```
node openapi-to-okf.mjs <openapi.json> <output-dir> [--base <api-base-url>]
```

Example:

```
node openapi-to-okf.mjs openapi.json out/ --base https://api.example.com
```

## What it emits

- one concept doc per operation (`type: "API Operation"`) with method, path,
  parameters, and relative-markdown links to the schemas it references
- one concept doc per `components.schemas` entry (`type: "Schema"`)
- frontmatter-free `index.md` directory listings and `log.md`, per the spec
- a bundle-root `index.md` that declares `okf_version` only

## Conformance

- every concept file has a non-empty `type`
- `okf_version` appears only in the bundle-root `index.md`
- all internal links are standard relative markdown (no `[[wiki]]` syntax)
- reserved files (`index.md`, `log.md`) carry no frontmatter, except the root
  `index.md` which carries `okf_version` only

## Example bundle

`example/` is a real bundle produced from a public production API (TempGuru's
event-staffing API: 7 operations, 13 schemas, 24 files). Regenerate with:

```
node openapi-to-okf.mjs path/to/openapi.json example/ --base https://mcp.tempguru.co
```
