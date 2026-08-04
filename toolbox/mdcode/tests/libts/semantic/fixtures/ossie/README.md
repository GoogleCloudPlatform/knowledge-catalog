# Vendored Apache Ossie reference examples

`tpcds_semantic_model.yaml` is copied **unmodified** from the Apache Ossie
project and is used here as an interop fixture: it proves the loader ingests a
real, spec-owner-authored OSI document (v0.2.0.dev0).

- Source: https://github.com/apache/ossie/blob/main/examples/tpcds_semantic_model.yaml
- License: Apache License 2.0 (the file retains its original ASF license header).

`osi-schema.json` is the OSI core JSON Schema (Draft 2020-12), copied unmodified
from the same project. `osi_schema.test.ts` validates every YAML fixture in this
tree against it, so a fixture that drifts from the spec (e.g. a dialect outside
the OSI enum) fails the suite. This is the same JSON-Schema check the Apache
validator (`validation/validate.py`) runs as its first step, done in-process with
ajv so it needs no Python/PyPI dependency.

- Source: https://github.com/apache/ossie/blob/main/core-spec/osi-schema.json
- License: Apache License 2.0.

These are test inputs only; they are not part of the shipped package.
