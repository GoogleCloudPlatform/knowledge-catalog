CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.bei_semantic_ir_verify.school_graph`
NODE TABLES (
  `sqlgen-testing.bei_semantic_ir_verify.students` AS students
    KEY(student_id)
    PROPERTIES(
      student_id,
      name
    ),
  `sqlgen-testing.bei_semantic_ir_verify.courses` AS courses
    KEY(course_id)
    PROPERTIES(
      course_id,
      title
    )
)
EDGE TABLES (
  `sqlgen-testing.bei_semantic_ir_verify.enrollment` AS enrollment
    KEY(enrollment_id)
    SOURCE KEY(student_id) REFERENCES students(student_id)
    DESTINATION KEY(course_id) REFERENCES courses(course_id)
    PROPERTIES(
      grade OPTIONS(description="Letter grade")
    )
);
