import json

from policy_as_code_agent.utils.llm import (
    generate_sample_values_str,
    get_json_schema_from_content,
)


def test_generate_sample_values_picks_representative():
    # Create a list where the second item is "larger" (more fields) than the first
    sparse_entry = {"name": "sparse", "id": 1}
    rich_entry = {
        "name": "rich",
        "id": 2,
        "details": {"description": "lots of data"},
        "tags": ["a", "b", "c"],
    }

    # Function should pick rich_entry because len(json.dumps(rich_entry)) > len(json.dumps(sparse_entry))
    sample_str = generate_sample_values_str([sparse_entry, rich_entry])
    sample_dict = json.loads(sample_str)

    assert sample_dict.get("name") == "rich"
    assert "details.description" in sample_dict
    assert "tags[]" in sample_dict


def test_generate_sample_values_empty():
    sample_str = generate_sample_values_str([])
    assert sample_str == "{}"


def test_generate_sample_values_traversal():
    # Define constants to fix PLR2004 (magic-value-comparison)
    val_a = 1
    val_b = 2
    val_c = 3
    val_d = 4
    val_e = 5

    data = [
        {
            "a": val_a,
            "nested": {"b": val_b, "deep": {"c": val_c}},
            "list_of_objs": [{"d": val_d}, {"d": val_e}],
        }
    ]

    sample_str = generate_sample_values_str(data)
    sample_dict = json.loads(sample_str)

    assert sample_dict.get("a") == val_a
    assert sample_dict.get("nested.b") == val_b
    assert sample_dict.get("nested.deep.c") == val_c
    assert sample_dict.get("list_of_objs[].d") == val_d


def test_get_json_schema_simple():
    content = '[{"name": "Alice", "age": 30}]'
    schema = get_json_schema_from_content(content)
    expected = {"name": "str", "age": "int"}
    assert schema == expected


def test_get_json_schema_nested():
    content = '[{"user": {"id": 1, "details": {"active": true}}}]'
    schema = get_json_schema_from_content(content)
    expected = {"user": {"id": "int", "details": {"active": "bool"}}}
    assert schema == expected


def test_get_json_schema_list():
    content = '[{"tags": ["a", "b"]}]'
    schema = get_json_schema_from_content(content)
    # The util merges list schemas, usually taking the first item's type
    expected = {"tags": ["str"]}
    assert schema == expected


def test_get_json_schema_jsonl():
    content = '{"a": 1}\n{"b": 2}'
    schema = get_json_schema_from_content(content)
    # It merges keys from both lines
    expected = {"a": "int", "b": "int"}
    assert schema == expected
