"""Build local-browser terrain bundles from the SDK JSON grids."""

from base64 import b64encode
import gzip
from pathlib import Path
from shutil import copyfileobj
from tempfile import NamedTemporaryFile


ROOT = Path(__file__).resolve().parents[1]


def build_grid(path):
    with path.open(encoding="utf-8") as grid:
        if '"schemaVersion": 2,' in grid.read(4096):
            grid.seek(0)
            output = path.with_suffix(".js")
            stream = NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                        dir=output.parent, delete=False)
            temporary = Path(stream.name)
            try:
                with stream:
                    stream.write("// Generated from terrain.json by tools/build-terrain.py.\n")
                    stream.write("document.currentScript.terrainData = ")
                    copyfileobj(grid, stream)
                    stream.write(";\n")
                temporary.replace(output)
            finally:
                temporary.unlink(missing_ok=True)
            return output
    compressed = gzip.compress(path.read_bytes(), compresslevel=6, mtime=0)
    payload = b64encode(compressed).decode("ascii")
    chunks = [f'  "{payload[start:start + 4096]}"' for start in range(0, len(payload), 4096)]
    rows = ",\n".join(chunks)
    source = ("// Generated from terrain.json by tools/build-terrain.py.\n"
              f'document.currentScript.terrainPayload = [\n{rows}\n].join("");\n')
    output = path.with_suffix(".js")
    if output.is_file() and output.read_text(encoding="utf-8") == source:
        return output

    stream = NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                dir=output.parent, delete=False)
    temporary = Path(stream.name)
    try:
        with stream:
            stream.write(source)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return output


if __name__ == "__main__":
    files = sorted((ROOT / "maps").glob("*/terrain.json"))
    if not files:
        raise SystemExit("No terrain grids were found.")
    for file in files:
        build_grid(file)
    print(f"Built {len(files)} terrain bundles.")
