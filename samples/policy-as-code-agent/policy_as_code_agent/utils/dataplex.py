import os

import google.auth


def get_project_id():
    """Gets the GCP project ID from environment or gcloud config."""
    project_id = os.environ.get("GOOGLE_CLOUD_PROJECT")
    if project_id:
        return project_id, None

    try:
        _, project_id = google.auth.default()
        if project_id:
            return project_id, None
    except (ImportError, google.auth.exceptions.DefaultCredentialsError):
        pass

    return (
        None,
        "GOOGLE_CLOUD_PROJECT environment variable not set, and could not determine default project ID.",
    )


def convert_proto_to_dict(proto_obj):
    """
    Recursively converts protobuf objects (including Structs and RepeatedComposites)
    into standard Python dictionaries and lists.
    """
    if hasattr(proto_obj, "keys"):  # Acts like a dict
        return {
            key: convert_proto_to_dict(value)
            for key, value in proto_obj.items()
        }
    elif hasattr(proto_obj, "__iter__") and not isinstance(
        proto_obj, str
    ):  # Acts like a list
        return [convert_proto_to_dict(item) for item in proto_obj]
    else:
        return proto_obj


def entry_to_dict(entry):
    """
    Manually converts a Dataplex Entry object to a dictionary that is
    compatible with the existing simulation logic.
    """
    entry_dict = {
        "name": entry.name,
        "entryType": entry.entry_type,
        "fullyQualifiedName": entry.fully_qualified_name,
        "parentEntry": entry.parent_entry,
        "aspects": {},
    }
    if entry.entry_source:
        entry_dict["entrySource"] = {
            "resource": entry.entry_source.resource,
            "system": entry.entry_source.system,
            "platform": entry.entry_source.platform,
            "displayName": entry.entry_source.display_name,
            "location": entry.entry_source.location,
            "labels": dict(entry.entry_source.labels),
        }
    for key, aspect in entry.aspects.items():
        entry_dict["aspects"][key] = {
            "aspectType": aspect.aspect_type,
            "data": convert_proto_to_dict(aspect.data),
        }
    return entry_dict
