CREATE OR REPLACE PROPERTY GRAPH people
NODE TABLES (
  person AS Person
    KEY(id)
    DEFAULT LABEL
    PROPERTIES(
      id,
      full_name,
      email
    ),
  customer AS Customer
    KEY(id)
    DEFAULT LABEL
    PROPERTIES(
      id,
      loyalty_tier,
      full_name,
      email
    )
    LABEL Person
    PROPERTIES(
      id,
      full_name,
      email
    ),
  employee AS Employee
    KEY(id)
    DEFAULT LABEL
    PROPERTIES(
      id,
      department,
      full_name,
      email
    )
    LABEL Person
    PROPERTIES(
      id,
      full_name,
      email
    ),
  manager AS Manager
    KEY(id)
    DEFAULT LABEL
    PROPERTIES(
      id,
      team_size,
      department,
      full_name,
      email
    )
    LABEL Employee
    PROPERTIES(
      id,
      department,
      full_name,
      email
    )
    LABEL Person
    PROPERTIES(
      id,
      full_name,
      email
    ),
  city AS City
    KEY(id)
    PROPERTIES(
      id,
      city_name
    )
)
EDGE TABLES (
  person AS livesIn
    KEY(id)
    SOURCE KEY(id) REFERENCES Person(id)
    DESTINATION KEY(city_id) REFERENCES City(id)
);

-- warnings --
-- note: no 'BIGQUERY' dialect for one or more expressions; using the portable 'ANSI_SQL' dialect verbatim ('BIGQUERY' accepts the ANSI core subset — supply 'BIGQUERY' variants only for BIGQUERY-specific SQL)
-- metric 'total_cities' is not emitted: Spanner Graph has no MEASURE, so model-level metrics have no home in it
