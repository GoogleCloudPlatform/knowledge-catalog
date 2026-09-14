CREATE OR REPLACE PROPERTY GRAPH school_graph
NODE TABLES (
  students AS students
    KEY(student_id)
    PROPERTIES(
      student_id,
      name
    ),
  courses AS courses
    KEY(course_id)
    PROPERTIES(
      course_id,
      title
    )
)
EDGE TABLES (
  enrollment AS enrollment
    KEY(enrollment_id)
    SOURCE KEY(student_id) REFERENCES students(student_id)
    DESTINATION KEY(course_id) REFERENCES courses(course_id)
    PROPERTIES(
      grade
    )
);
