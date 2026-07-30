# Contributing

This is a fork of
[GoogleCloudPlatform/knowledge-catalog](https://github.com/GoogleCloudPlatform/knowledge-catalog)
that ports the reference agent to AWS Glue and Athena.

**Contributing upstream:** changes to the Open Knowledge Format itself
belong in the upstream repo, which requires a Google Contributor License
Agreement — see <https://cla.developers.google.com/>. That CLA does not
apply to this fork.

**Contributing here:** AWS-specific work on `okf/` is welcome by pull
request.

To get started:

1. Fork the repo, develop and test your changes.
2. Match the existing style — the Python code uses
   `from __future__ import annotations`, full type hints, and no comments
   restating what the code says.
3. Add tests. `okf/` follows TDD: write the failing test first. Tests must
   be deterministic — mock boto3 with stub clients, never call live AWS,
   and never call the LLM.
4. Run the suite: `cd okf && .venv/bin/pytest`.
5. Submit a pull request.

## Code reviews

All submissions, including submissions by project members, require review.
We use GitHub pull requests for this purpose.
