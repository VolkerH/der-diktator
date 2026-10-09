"""Record the actual installed distributions; wheel license files remain installed."""

import importlib.metadata
import json

packages = [
    {
        "name": distribution.metadata["Name"],
        "version": distribution.version,
        "license": distribution.metadata.get("License-Expression")
        or distribution.metadata.get("License")
        or "See distribution metadata and bundled license files",
        "license_files": distribution.metadata.get_all("License-File", []),
    }
    for distribution in importlib.metadata.distributions()
]
print(json.dumps(sorted(packages, key=lambda package: package["name"].lower()), indent=2))
