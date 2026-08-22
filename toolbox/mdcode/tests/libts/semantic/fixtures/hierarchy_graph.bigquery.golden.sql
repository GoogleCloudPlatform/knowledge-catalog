CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.people`
NODE TABLES (
  `sqlgen-testing.demo.person` AS Person
    KEY(id)
    OPTIONS(description="A human being")
    PROPERTIES(
      id,
      full_name OPTIONS(description="Full Name"),
      email,
      MEASURE(COUNT(id)) AS total_people OPTIONS(description="Number of people")
    ),
  `sqlgen-testing.demo.customer` AS Customer
    KEY(id)
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
      city_name
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
