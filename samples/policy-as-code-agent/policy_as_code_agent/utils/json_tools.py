def traverse(obj, sample_values, path=""):
    """
    Recursively traverses a JSON object to populate the sample_values dictionary.
    """
    if isinstance(obj, dict):
        for k, v in obj.items():
            new_path = f"{path}.{k}" if path else k
            traverse(v, sample_values, new_path)
    elif isinstance(obj, list):
        # To keep the sample concise, we only traverse the first item in a list.
        if obj:
            traverse(obj[0], sample_values, f"{path}[]")
    # We only want to store the first value we encounter for a given path.
    elif path not in sample_values:
        sample_values[path] = obj
