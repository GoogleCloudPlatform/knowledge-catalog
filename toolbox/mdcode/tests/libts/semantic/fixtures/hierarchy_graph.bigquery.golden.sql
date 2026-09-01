CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.people`
NODE TABLES (
  `sqlgen-testing.demo.person` AS Person
    KEY(id)
    DEFAULT LABEL
    PROPERTIES(
      id,
      full_name OPTIONS(description="Full Name"),
      email
    ),
  `sqlgen-testing.demo.customer` AS Customer
    KEY(id)
    DEFAULT LABEL
    PROPERTIES(
      id,
      loyalty_tier,
      full_name OPTIONS(description="Full Name"),
      email
    )
    LABEL Person
    PROPERTIES(
      id,
      full_name OPTIONS(description="Full Name"),
      email
    ),
  `sqlgen-testing.demo.employee` AS Employee
    KEY(id)
    DEFAULT LABEL
    PROPERTIES(
      id,
      department,
      full_name OPTIONS(description="Full Name"),
      email
    )
    LABEL Person
    PROPERTIES(
      id,
      full_name OPTIONS(description="Full Name"),
      email
    ),
  `sqlgen-testing.demo.manager` AS Manager
    KEY(id)
    DEFAULT LABEL
    PROPERTIES(
      id,
      team_size,
      department,
      full_name OPTIONS(description="Full Name"),
      email
    )
    LABEL Employee
    PROPERTIES(
      id,
      department,
      full_name OPTIONS(description="Full Name"),
      email
    )
    LABEL Person
    PROPERTIES(
      id,
      full_name OPTIONS(description="Full Name"),
      email
    ),
  `sqlgen-testing.demo.city` AS City
    KEY(id)
    PROPERTIES(
      id,
      city_name,
      MEASURE(COUNT(id)) AS total_cities OPTIONS(description="Number of cities")
    )
)
EDGE TABLES (
  `sqlgen-testing.demo.person` AS livesIn
    KEY(id)
    SOURCE KEY(id) REFERENCES Person(id)
    DESTINATION KEY(city_id) REFERENCES City(id)
);

-- warnings --
-- note: no 'BIGQUERY' dialect for one or more expressions; using the portable 'ANSI_SQL' dialect verbatim ('BIGQUERY' accepts the ANSI core subset — supply 'BIGQUERY' variants only for BIGQUERY-specific SQL)
-- entity 'Person' is a supertype in a class hierarchy; its description/synonyms are dropped from the shared 'Person' label (BigQuery forbids OPTIONS on a label bound by multiple tables)
