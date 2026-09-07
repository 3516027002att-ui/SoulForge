"""Trusted, fixed-operation Blender adapter for SoulForge.

This module is intentionally not a general Python console.  The host passes a
JSON JobManifest and the adapter only emits a bounded result manifest for the
registered operation names.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


ALLOWED = {"export_snapshot", "apply_placement_delta", "export_mesh_channels"}


def fail(code: str, message: str) -> int:
    print(json.dumps({"ok": False, "code": code, "message": message}), file=sys.stderr)
    return 2


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] != "--job":
        return fail("BLENDER_ADAPTER_ARGS_INVALID", "expected --job <manifest>")
    manifest_path = Path(argv[2])
    if not manifest_path.is_absolute() or not manifest_path.is_file():
        return fail("BLENDER_MANIFEST_NOT_FOUND", "manifest path must be an existing absolute file")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schemaVersion") != 1:
            return fail("BLENDER_MANIFEST_SCHEMA_UNSUPPORTED", "schemaVersion must be 1")
        operations = manifest.get("allowedOperations")
        if not isinstance(operations, list) or not operations or any(item not in ALLOWED for item in operations):
            return fail("BLENDER_OPERATION_UNSUPPORTED", "operation is outside the fixed adapter allowlist")
        output_handle = manifest.get("outputDirectoryHandle")
        if not isinstance(output_handle, str) or not output_handle or Path(output_handle).is_absolute() or ".." in Path(output_handle).parts:
            return fail("BLENDER_OUTPUT_PATH_INVALID", "outputDirectoryHandle must be a safe relative path")
        root = manifest_path.parent
        output_dir = (root / output_handle).resolve()
        if root.resolve() not in output_dir.parents and output_dir != root.resolve():
            return fail("BLENDER_OUTPUT_PATH_INVALID", "output directory escapes job root")
        output_dir.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"jobId": manifest.get("jobId"), "operations": operations}, sort_keys=True).encode("utf-8")
        output_path = output_dir / "adapter-output.json"
        output_path.write_bytes(payload)
        result = {
            "schemaVersion": 1,
            "jobId": manifest.get("jobId"),
            "adapterVersion": manifest.get("adapterVersion"),
            "coordinateProfileHash": manifest.get("coordinateProfileHash"),
            "inputArtifactIds": manifest.get("inputArtifactIds", []),
            "operationCount": manifest.get("operationCount"),
            "outputs": [{
                "relativePath": str(Path(output_handle) / output_path.name).replace("\\", "/"),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "byteLength": len(payload),
            }],
            "diagnostics": [{"severity": "warning", "code": "BLENDER_PROFILE_BOUNDARY", "message": "adapter output is staged only; native FLVER writeback remains profile-gated"}],
        }
        (output_dir / "result-manifest.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps({"ok": True, "jobId": manifest.get("jobId"), "resultManifest": str(Path(output_handle) / "result-manifest.json").replace("\\", "/")}))
        return 0
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        return fail("BLENDER_ADAPTER_FAILED", str(error))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
