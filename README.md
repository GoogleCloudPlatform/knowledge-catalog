# Knowledge Catalog — AWS fork

A fork of [GoogleCloudPlatform/knowledge-catalog](https://github.com/GoogleCloudPlatform/knowledge-catalog),
ported to AWS. The reference agent reads the **AWS Glue Data Catalog**
and emits [Open Knowledge Format](okf/SPEC.md) bundles — plain markdown
with YAML frontmatter that describes your data assets.

## Contents

- [`okf/`](okf/) — the OKF specification, the AWS reference agent
  (`aws-reference-agent`), and the bundle visualizer. **This is the
  ported part**; start at [`okf/README.md`](okf/README.md).
- [`samples/`](samples/) — Google Knowledge Catalog samples inherited
  from upstream. Not ported; they still target GCP.
- [`toolbox/`](toolbox/) — markdown/code utilities inherited from
  upstream. Source-agnostic, but their demo fixtures are GCP-flavoured.

## Quick start

```
cd okf
uv sync
uv run aws-reference-agent --help
```

See [`okf/README.md`](okf/README.md) for AWS prerequisites, the IAM
policy, and how to run the agent against your own Glue database.

## License

All solutions within this repository are provided under the
[Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) license. See
[LICENSE](LICENSE.md) for terms and conditions.

## Disclaimer

This repository and its contents are not an official Google product, and
this fork is not affiliated with or endorsed by Google or AWS.
