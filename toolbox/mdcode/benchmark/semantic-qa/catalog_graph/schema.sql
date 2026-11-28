-- SemanticCatalog: the semantic models themselves, as a Spanner property graph.
--
-- NOT the graph kcmd deploys from a model. That one is a DATA graph: its nodes
-- are customers and orders. This is a CATALOG graph: its nodes are the model
-- elements -- Model, Entity, Field, Metric -- so a question can be answered by
-- searching for concepts and then traversing to everything they depend on.
--
-- Two things the data graph cannot do, which motivate this one. Spanner Graph
-- has no MEASURE, so model-level metrics have no home there (spanner.ts:14);
-- here a Metric is a first-class node. And Spanner Graph carries no
-- per-element OPTIONS, so descriptions and synonyms have nowhere to live
-- there (spanner.ts:17); here they are column VALUES, which means they are
-- full-text searchable.
--
-- Verified end to end against a real instance: this file creates cleanly in
-- one shot, and SEARCH() works inside a GRAPH ... MATCH statement, so search
-- and traversal are a single query rather than two phases.
--
--   gcloud spanner databases create semantic_catalog \
--     --instance=my-instance --ddl-file=schema.sql
--
-- Field appears as both a NODE table and the HAS_FIELD EDGE table. That is
-- legal and already relied on by the data-graph emitter, where a source
-- entity table doubles as its own FK edge table (spanner.ts:290).

CREATE TABLE SemanticModel (
  model_id STRING(64) NOT NULL,
  name STRING(128) NOT NULL,
  description STRING(MAX),
  instructions STRING(MAX),
  osi_version STRING(32),
  search_tokens TOKENLIST AS (TOKENIZE_FULLTEXT(
    name || ' ' || IFNULL(description, '') || ' ' || IFNULL(instructions, '')
  )) HIDDEN
) PRIMARY KEY (model_id);

CREATE TABLE Entity (
  model_id STRING(64) NOT NULL,
  entity_id STRING(64) NOT NULL,
  name STRING(128) NOT NULL,
  description STRING(MAX),
  instructions STRING(MAX),
  synonyms ARRAY<STRING(MAX)>,
  is_abstract BOOL,
  source STRING(512),
  search_tokens TOKENLIST AS (TOKENIZE_FULLTEXT(
    name || ' ' || IFNULL(description, '') || ' ' || IFNULL(instructions, '')
    || ' ' || IFNULL(ARRAY_TO_STRING(synonyms, ' '), '')
  )) HIDDEN
) PRIMARY KEY (model_id, entity_id),
  INTERLEAVE IN PARENT SemanticModel ON DELETE CASCADE;

CREATE TABLE Field (
  model_id STRING(64) NOT NULL,
  entity_id STRING(64) NOT NULL,
  field_id STRING(64) NOT NULL,
  name STRING(128) NOT NULL,
  description STRING(MAX),
  label STRING(128),
  datatype STRING(32),
  expression STRING(MAX),
  is_time BOOL,
  synonyms ARRAY<STRING(MAX)>,
  search_tokens TOKENLIST AS (TOKENIZE_FULLTEXT(
    name || ' ' || IFNULL(description, '') || ' ' || IFNULL(label, '')
    || ' ' || IFNULL(ARRAY_TO_STRING(synonyms, ' '), '')
  )) HIDDEN
) PRIMARY KEY (model_id, entity_id, field_id),
  INTERLEAVE IN PARENT Entity ON DELETE CASCADE;

CREATE TABLE Metric (
  model_id STRING(64) NOT NULL,
  metric_id STRING(64) NOT NULL,
  name STRING(128) NOT NULL,
  description STRING(MAX),
  instructions STRING(MAX),
  synonyms ARRAY<STRING(MAX)>,
  datatype STRING(32),
  expression STRING(MAX),
  search_tokens TOKENLIST AS (TOKENIZE_FULLTEXT(
    name || ' ' || IFNULL(description, '') || ' ' || IFNULL(instructions, '')
    || ' ' || IFNULL(ARRAY_TO_STRING(synonyms, ' '), '')
  )) HIDDEN
) PRIMARY KEY (model_id, metric_id),
  INTERLEAVE IN PARENT SemanticModel ON DELETE CASCADE;

CREATE TABLE MetricReadsField (
  model_id STRING(64) NOT NULL,
  metric_id STRING(64) NOT NULL,
  ref_entity_id STRING(64) NOT NULL,
  ref_field_id STRING(64) NOT NULL,
  named_entity_id STRING(64) NOT NULL,
  inherited BOOL
) PRIMARY KEY (model_id, metric_id, ref_entity_id, ref_field_id, named_entity_id),
  INTERLEAVE IN PARENT Metric ON DELETE CASCADE;

CREATE TABLE EntityJoin (
  model_id STRING(64) NOT NULL,
  relationship_id STRING(64) NOT NULL,
  from_entity_id STRING(64) NOT NULL,
  to_entity_id STRING(64) NOT NULL,
  name STRING(128),
  instructions STRING(MAX),
  from_columns ARRAY<STRING(MAX)>,
  to_columns ARRAY<STRING(MAX)>
) PRIMARY KEY (model_id, relationship_id),
  INTERLEAVE IN PARENT SemanticModel ON DELETE CASCADE;

CREATE TABLE EntityExtends (
  model_id STRING(64) NOT NULL,
  entity_id STRING(64) NOT NULL,
  supertype_entity_id STRING(64) NOT NULL
) PRIMARY KEY (model_id, entity_id, supertype_entity_id),
  INTERLEAVE IN PARENT SemanticModel ON DELETE CASCADE;
CREATE SEARCH INDEX ModelSearch ON SemanticModel(search_tokens);
CREATE SEARCH INDEX EntitySearch ON Entity(search_tokens);
CREATE SEARCH INDEX FieldSearch ON Field(search_tokens);
CREATE SEARCH INDEX MetricSearch ON Metric(search_tokens);
CREATE OR REPLACE PROPERTY GRAPH SemanticCatalog
NODE TABLES (
  SemanticModel KEY (model_id) LABEL Model,
  Entity KEY (model_id, entity_id),
  Field KEY (model_id, entity_id, field_id),
  Metric KEY (model_id, metric_id)
)
EDGE TABLES (
  Field AS HasField
    KEY (model_id, entity_id, field_id)
    SOURCE KEY (model_id, entity_id) REFERENCES Entity (model_id, entity_id)
    DESTINATION KEY (model_id, entity_id, field_id) REFERENCES Field (model_id, entity_id, field_id)
    LABEL HAS_FIELD,
  MetricReadsField
    KEY (model_id, metric_id, ref_entity_id, ref_field_id, named_entity_id)
    SOURCE KEY (model_id, metric_id) REFERENCES Metric (model_id, metric_id)
    DESTINATION KEY (model_id, ref_entity_id, ref_field_id) REFERENCES Field (model_id, entity_id, field_id)
    LABEL READS,
  MetricReadsField AS MetricTouchesEntity
    KEY (model_id, metric_id, ref_entity_id, ref_field_id, named_entity_id)
    SOURCE KEY (model_id, metric_id) REFERENCES Metric (model_id, metric_id)
    DESTINATION KEY (model_id, named_entity_id) REFERENCES Entity (model_id, entity_id)
    LABEL TOUCHES,
  EntityJoin
    KEY (model_id, relationship_id)
    SOURCE KEY (model_id, from_entity_id) REFERENCES Entity (model_id, entity_id)
    DESTINATION KEY (model_id, to_entity_id) REFERENCES Entity (model_id, entity_id)
    LABEL JOINS,
  EntityExtends
    KEY (model_id, entity_id, supertype_entity_id)
    SOURCE KEY (model_id, entity_id) REFERENCES Entity (model_id, entity_id)
    DESTINATION KEY (model_id, supertype_entity_id) REFERENCES Entity (model_id, entity_id)
    LABEL EXTENDS
);
