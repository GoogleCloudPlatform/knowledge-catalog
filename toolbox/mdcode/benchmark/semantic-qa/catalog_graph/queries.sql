-- Canonical queries over the SemanticCatalog graph.
--
-- Each block is named with `-- name:` and is run by run_queries.py, so what is
-- written here is what has actually been executed against a real instance.
-- Parameters are spelled as literals rather than @params because
-- `gcloud spanner databases execute-sql` takes no parameter bindings; a real
-- caller should bind them.

-- name: search-metrics
-- Plain full-text search over metric entries. The question text never
-- contains the metric name.
SELECT model_id, metric_id, description
FROM Metric
WHERE SEARCH(search_tokens, 'average order basket')
ORDER BY model_id, metric_id
LIMIT 5;

-- name: search-inside-graph
-- The same search, but INSIDE a graph statement. This works, including
-- against the HIDDEN TOKENLIST column, which is what lets search and
-- traversal be one query instead of a seed-then-expand round trip.
GRAPH SemanticCatalog
MATCH (m:Metric)
WHERE SEARCH(m.search_tokens, 'average order basket')
RETURN m.model_id, m.name
LIMIT 5;

-- name: dependency-closure
-- The headline query. A natural-language phrase goes in; every concrete
-- entity needed to answer comes out, with the physical table and whether the
-- field reference was inherited. This is what gets handed back to a caller so
-- it can decide the next step.
GRAPH SemanticCatalog
MATCH (m:Metric)-[t:TOUCHES]->(e:Entity)
WHERE SEARCH(m.search_tokens, 'total outstanding exposure book')
RETURN DISTINCT m.model_id, m.name AS metric, e.name AS needs_entity,
       e.source, e.is_abstract, t.inherited
ORDER BY metric, needs_entity;

-- name: metric-fields
-- Field-level detail for one metric, naming where each field is DECLARED.
-- For total_exposure that is the abstract credit_account -- one field, which
-- is why the closure above needs the TOUCHES edge to reach three tables.
GRAPH SemanticCatalog
MATCH (m:Metric)-[:READS]->(f:Field)<-[:HAS_FIELD]-(d:Entity)
WHERE m.model_id = 'lending_credit' AND m.metric_id = 'total_exposure'
RETURN DISTINCT f.name AS field, f.datatype, d.name AS declared_on,
       d.is_abstract
ORDER BY field;

-- name: subtypes-of-abstract
-- Walk EXTENDS downward: which concrete entities carry an abstract one's
-- fields. Needed whenever a metric reads a supertype field.
GRAPH SemanticCatalog
MATCH (sub:Entity)-[:EXTENDS]->(super:Entity)
WHERE super.model_id = 'lending_credit' AND super.entity_id = 'credit_account'
RETURN sub.name AS concrete_subtype, sub.source
ORDER BY concrete_subtype;

-- name: join-path
-- The shortest join path between two entities a metric touches. Variable
-- length, so no fixed number of joins would do -- this is the part that
-- genuinely needs a graph.
GRAPH SemanticCatalog
MATCH ANY SHORTEST (a:Entity)-[j:JOINS]-{1,4}(b:Entity)
WHERE a.model_id = 'retail_sales' AND a.entity_id = 'order_line'
  AND b.model_id = 'retail_sales' AND b.entity_id = 'store'
RETURN ARRAY_LENGTH(j) AS hops,
       ARRAY_TO_STRING(ARRAY(SELECT e.name FROM UNNEST(j) AS e), ' -> ') AS path;

-- name: impact-of-a-field
-- The reverse direction: if this column changes, which metrics break. Same
-- READS edge, traversed backwards.
GRAPH SemanticCatalog
MATCH (m:Metric)-[:READS]->(f:Field)
WHERE f.model_id = 'retail_sales' AND f.entity_id = 'order_line'
  AND f.field_id = 'discount_amount'
RETURN m.name AS affected_metric
ORDER BY affected_metric;

-- name: cross-model-collision
-- What a bare domain term returns across the whole corpus. Two models answer
-- "utilization" with unrelated meanings, which is the disambiguation case.
GRAPH SemanticCatalog
MATCH (m:Metric)
WHERE SEARCH(m.search_tokens, 'utilization')
RETURN m.model_id, m.name, m.description
ORDER BY m.model_id, m.name;

-- name: idiom-miss
-- An honest negative. Pure idiom with no lexical overlap returns nothing from
-- full-text search, which is the limit that motivates embeddings.
GRAPH SemanticCatalog
MATCH (m:Metric)
WHERE SEARCH(m.search_tokens, 'money out on the street')
RETURN m.model_id, m.name;

-- name: corpus-totals
-- What is loaded. Three corpora share one graph: the six benchmark models,
-- the repo's own test fixtures, and the commerce demo.
SELECT corpus, COUNT(*) AS models
FROM SemanticModel
GROUP BY corpus
ORDER BY corpus;

-- name: duplicate-model-names
-- A real discovery problem the fixtures expose: several documents declare a
-- model NAMED the same thing. The catalog keys on the document id, so they
-- coexist, but a user searching for "sales" gets all of them and nothing in
-- the name distinguishes them.
SELECT name, COUNT(*) AS documents,
       STRING_AGG(model_id, ', ' ORDER BY model_id) AS model_ids
FROM SemanticModel
GROUP BY name
HAVING COUNT(*) > 1
ORDER BY documents DESC, name;

-- name: search-across-corpora
-- One search over everything, reporting which corpus each hit came from so a
-- caller can prefer curated models over test scaffolding.
GRAPH SemanticCatalog
MATCH (m:Metric)
WHERE SEARCH(m.search_tokens, 'total revenue')
RETURN m.model_id, m.name
ORDER BY m.model_id, m.name
LIMIT 10;

-- name: search-semantics
-- SEARCH() is AND semantics: every token must be present, so one word the
-- corpus does not know zeroes the result. A raw natural-language question
-- therefore returns nothing, which is the single most important constraint on
-- wiring this to an NL front end. The OR operator lifts recall but does not
-- fix vocabulary mismatch -- "sell" matches nothing whichever way it is
-- combined, because no model uses the word.
SELECT 'raw question (AND)' AS probe,
       (SELECT COUNT(*) FROM Metric
        WHERE SEARCH(search_tokens, 'How much did we sell last quarter')) AS hits
UNION ALL SELECT 'revenue',
       (SELECT COUNT(*) FROM Metric WHERE SEARCH(search_tokens, 'revenue'))
UNION ALL SELECT 'net revenue',
       (SELECT COUNT(*) FROM Metric WHERE SEARCH(search_tokens, 'net revenue'))
UNION ALL SELECT 'net revenue + one unknown token',
       (SELECT COUNT(*) FROM Metric WHERE SEARCH(search_tokens, 'net revenue zzz'))
UNION ALL SELECT 'sell OR revenue',
       (SELECT COUNT(*) FROM Metric WHERE SEARCH(search_tokens, 'sell OR revenue'))
ORDER BY probe;
