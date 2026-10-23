"""Create verified ZIP archives from the Node-side explicit allowlist."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tempfile
import zipfile


def inside(root, candidate):
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValueError(f"Path escapes the project: {candidate}") from error
    return candidate


def archive_name(value):
    if not isinstance(value, str) or not value or "\\" in value or ":" in value or "\x00" in value:
        raise ValueError(f"Unsafe archive path: {value!r}")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts) or PurePosixPath(value).is_absolute():
        raise ValueError(f"Unsafe archive path: {value!r}")
    return value


def main():
    root = Path(sys.argv[1]).resolve(strict=True)
    plan = json.load(sys.stdin)
    release_path = root / "release"
    if release_path.is_symlink():
        raise ValueError("Release directory must not be a symlink")
    release = inside(root, release_path.resolve())
    release.mkdir(exist_ok=True)
    checksums = []
    for archive in plan["archives"]:
        filename = archive_name(archive["name"])
        if "/" in filename or not filename.endswith(".zip"):
            raise ValueError(f"Invalid ZIP filename: {filename}")
        destination = inside(release, (release / filename).resolve())
        entries = archive["entries"]
        names = set()
        with tempfile.NamedTemporaryFile(prefix=".package-", suffix=".zip.tmp", dir=release, delete=False) as temporary:
            temporary_path = Path(temporary.name)
        try:
            with zipfile.ZipFile(temporary_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=True) as output:
                for entry in entries:
                    source_name = archive_name(entry["source"])
                    source = inside(root, (root / source_name).resolve(strict=True))
                    if not source.is_file():
                        raise ValueError(f"Expected a regular input file: {source}")
                    name = archive_name(entry["archive"])
                    if name in names:
                        raise ValueError(f"Duplicate ZIP entry: {name}")
                    names.add(name)
                    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                    info.create_system = 3
                    info.external_attr = 0o100644 << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    output.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
            with zipfile.ZipFile(temporary_path, "r") as check:
                corrupt = check.testzip()
                if corrupt:
                    raise ValueError(f"ZIP CRC verification failed: {corrupt}")
                if set(check.namelist()) != names:
                    raise ValueError("ZIP entries do not match the explicit allowlist")
            os.replace(temporary_path, destination)
        finally:
            if temporary_path.exists():
                temporary_path.unlink()
        digest = hashlib.sha256()
        with destination.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        checksums.append(f"{digest.hexdigest()}  {filename}")
        print(f"Created {destination.name}: {len(entries)} files, {destination.stat().st_size} bytes", flush=True)
    checksum_file = inside(release, (release / "SHA256SUMS").resolve())
    with checksum_file.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write("\n".join(checksums) + "\n")
    print("\n".join(checksums), flush=True)


if __name__ == "__main__":
    main()
