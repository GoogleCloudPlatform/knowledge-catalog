name: manifest_simple
description: Simple minimal manifest
setup:
  catalog:
    entryGroups:
      - name: projects/test/locations/us/entryGroups/g1

  fileSystem:
    catalog.yaml: |
      scope: entryGroup.test.us.g1

assert:
  fileSystem:
    catalog.yaml:
      contains: "scope: entryGroup.test.us.g1"
