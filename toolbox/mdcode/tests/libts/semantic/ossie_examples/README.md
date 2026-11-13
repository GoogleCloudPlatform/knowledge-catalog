# Apache Ossie 0.3.0.dev0 examples

`tpcds_semantic_model.yaml` and `renamed_fields.yaml` are copied unchanged
from the `examples/` directory of the Apache Ossie project at commit
900d637ede768e7ef9f52dfc9d25f3b98914f0e4. Each keeps its Apache License 2.0
header. `import_ossie.test.ts` imports them as third-party input.

- Source: https://github.com/apache/ossie/tree/900d637ede768e7ef9f52dfc9d25f3b98914f0e4/examples

They sit outside `fixtures/`, since `osi_schema.test.ts` checks every YAML
file there against the schema its version names, and no schema there covers
0.3.0.dev0.
