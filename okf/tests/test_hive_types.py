from __future__ import annotations

from aws_reference_agent.sources.hive_types import column_to_field, parse_hive_type


def test_should_parse_primitive_type_when_given_int():
    assert parse_hive_type("int") == {"type": "int"}


def test_should_preserve_precision_when_given_decimal_with_commas():
    assert parse_hive_type("decimal(10,2)") == {"type": "decimal(10,2)"}


def test_should_mark_repeated_when_given_array_of_string():
    assert parse_hive_type("array<string>") == {"type": "string", "mode": "REPEATED"}


def test_should_expand_struct_fields_when_given_array_of_struct():
    result = parse_hive_type("array<struct<a:int,b:string>>")
    assert result == {
        "type": "struct",
        "mode": "REPEATED",
        "fields": [
            {"name": "a", "type": "int", "mode": "NULLABLE"},
            {"name": "b", "type": "string", "mode": "NULLABLE"},
        ],
    }


def test_should_expand_nested_fields_when_given_struct_with_array_field():
    result = parse_hive_type("struct<a:int,b:array<string>>")
    assert result == {
        "type": "struct",
        "mode": "NULLABLE",
        "fields": [
            {"name": "a", "type": "int", "mode": "NULLABLE"},
            {"name": "b", "type": "string", "mode": "REPEATED"},
        ],
    }


def test_should_describe_key_and_value_types_when_given_map():
    result = parse_hive_type("map<string,int>")
    assert result == {
        "type": "map",
        "key_type": "string",
        "value_type": {"type": "int"},
    }


def test_should_split_at_correct_depth_when_struct_field_contains_decimal_commas():
    result = parse_hive_type("struct<a:decimal(10,2),b:map<string,array<int>>>")
    assert result["type"] == "struct"
    fields = {f["name"]: f for f in result["fields"]}
    assert fields["a"] == {"name": "a", "type": "decimal(10,2)", "mode": "NULLABLE"}
    assert fields["b"]["name"] == "b"
    assert fields["b"]["type"] == "map"
    assert fields["b"]["key_type"] == "string"
    assert fields["b"]["value_type"] == {"type": "int", "mode": "REPEATED"}


def test_should_fall_back_to_raw_string_when_type_is_unparseable():
    assert parse_hive_type("struct<a:int") == {"type": "struct<a:int"}
    assert parse_hive_type("") == {"type": ""}


def test_should_merge_name_and_type_when_converting_column():
    col = {"Name": "user_id", "Type": "bigint", "Comment": "primary key"}
    assert column_to_field(col) == {
        "name": "user_id",
        "type": "bigint",
        "description": "primary key",
    }


def test_should_omit_description_when_comment_is_empty():
    col = {"Name": "user_id", "Type": "bigint", "Comment": ""}
    assert column_to_field(col) == {"name": "user_id", "type": "bigint"}


def test_should_omit_description_when_comment_is_missing():
    col = {"Name": "user_id", "Type": "bigint"}
    assert column_to_field(col) == {"name": "user_id", "type": "bigint"}


def test_should_expand_struct_fields_when_converting_column_with_struct_type():
    col = {"Name": "payload", "Type": "struct<a:int,b:string>"}
    result = column_to_field(col)
    assert result["name"] == "payload"
    assert result["type"] == "struct"
    assert result["mode"] == "NULLABLE"
    assert result["fields"] == [
        {"name": "a", "type": "int", "mode": "NULLABLE"},
        {"name": "b", "type": "string", "mode": "NULLABLE"},
    ]
