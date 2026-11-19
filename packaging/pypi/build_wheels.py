"""Build the PyPI wheels for context-fern from the release tarballs.

Standard library only (no new dependency; a wheel is a zip with a small
fixed layout, PEP 427). Never executes anything it unpacks.

One platform wheel per launch target. The compiled binary goes under
`<name>.data/scripts/`, which pip installs as a real executable (a real
`.exe` on Windows, which exec-form hooks need; npm's `.cmd` shim would
not do). Its native sidecar goes under `<name>.data/data/share/context-fern/`
because uv rejects a subdirectory in `scripts/`. The embedding model is NOT in these
wheels: it ships once, as the pure-data `context-fern-model` wheel,
depended on exactly by every platform wheel. See docs/decisions.md.

    python -I packaging/pypi/build_wheels.py \
        --version 0.1.0 --model-version 1.0.0 \
        --bundle-dir release --out dist-pkg
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import sys
import tarfile
import zipfile
from pathlib import Path

PRODUCT = "context-fern"
MODEL_PRODUCT = "context-fern-model"
SUMMARY = "A free, local context router for coding agents."
FIXED_TIME = (2026, 1, 1, 0, 0, 0)  # reproducible archives

# target -> (wheel platform tag, exe suffix). The Linux floor is glibc 2.28
# and the macOS floor 14.0, both measured from the shipped files, not
# assumed: see docs/decisions.md.
TARGETS: dict[str, tuple[str, str]] = {
    "win-x64": ("win_amd64", ".exe"),
    "linux-x64": ("manylinux_2_28_x86_64", ""),
    "linux-arm64": ("manylinux_2_28_aarch64", ""),
    "darwin-arm64": ("macosx_14_0_arm64", ""),
}

LAUNCHER = '''\
"""`fern` for a pip install: runs the real binary next to it.

The real `context-fern` binary is installed beside this launcher by the
wheel. `fern` is the short interactive name; machine-invoked entry
points (hooks, MCP) use `context-fern` directly, never this shim.
"""

import os
import subprocess
import sys


def main() -> int:
    here = os.path.dirname(os.path.abspath(sys.argv[0]))
    exe = os.path.join(here, "context-fern" + (".exe" if os.name == "nt" else ""))
    if not os.path.exists(exe):
        sys.stderr.write("fern: context-fern binary not found next to this launcher.\\n")
        return 127
    if os.name == "nt":
        return subprocess.call([exe, *sys.argv[1:]])
    os.execv(exe, [exe, *sys.argv[1:]])
    return 127  # not reached
'''


def b64(digest: bytes) -> str:
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


class WheelWriter:
    def __init__(self, path: Path, dist_info: str) -> None:
        self.zf = zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9)
        self.dist_info = dist_info
        self.records: list[tuple[str, str, int]] = []

    def add(self, name: str, data: bytes, executable: bool = False) -> None:
        info = zipfile.ZipInfo(name, FIXED_TIME)
        info.compress_type = zipfile.ZIP_DEFLATED
        # The regular-file type bits (0o100000) are required: pip only marks an entry executable when S_ISREG(mode) holds.
        info.external_attr = (0o100755 if executable else 0o100644) << 16
        self.zf.writestr(info, data, compresslevel=9)
        self.records.append(
            (name, "sha256=" + b64(hashlib.sha256(data).digest()), len(data))
        )

    def close(self) -> None:
        record_name = f"{self.dist_info}/RECORD"
        lines = [f"{n},{h},{s}" for n, h, s in self.records] + [f"{record_name},,"]
        info = zipfile.ZipInfo(record_name, FIXED_TIME)
        info.external_attr = 0o100644 << 16
        self.zf.writestr(info, "\n".join(lines) + "\n")
        self.zf.close()


def metadata(
    name: str, version: str, requires: list[str], repo_url: str
) -> bytes:
    lines = [
        "Metadata-Version: 2.1",
        f"Name: {name}",
        f"Version: {version}",
        f"Summary: {SUMMARY}",
        "License: Apache-2.0",
        f"Home-page: {repo_url}",
        f"Project-URL: Source, {repo_url}",
        "Requires-Python: >=3.9",
    ] + [f"Requires-Dist: {r}" for r in requires]
    return ("\n".join(lines) + "\n").encode()


def wheel_file(tag: str, purelib: bool) -> bytes:
    return (
        "Wheel-Version: 1.0\nGenerator: context-fern-pack\n"
        f"Root-Is-Purelib: {'true' if purelib else 'false'}\nTag: {tag}\n"
    ).encode()


def read_tar(path: Path) -> list[tuple[str, bytes, bool]]:
    """(relative name, bytes, executable) for each regular file. Refuses anything that could escape the archive."""
    out: list[tuple[str, bytes, bool]] = []
    with tarfile.open(path) as t:
        for m in t.getmembers():
            if m.isdir():
                continue
            if not m.isfile():
                raise SystemExit(
                    f"refusing non-regular member in {path.name}: {m.name}"
                )
            name = m.name.removeprefix("./")
            if name.startswith("/") or ".." in Path(name).parts:
                raise SystemExit(f"refusing unsafe path in {path.name}: {name}")
            f = t.extractfile(m)
            assert f is not None
            out.append((name, f.read(), bool(m.mode & 0o111)))
    return out


def build_platform_wheel(
    version: str,
    model_version: str,
    target: str,
    tarball: Path,
    out: Path,
    *,
    repo_url: str,
) -> Path:
    tag, suffix = TARGETS[target]
    norm = PRODUCT.replace("-", "_")
    dist_info = f"{norm}-{version}.dist-info"
    data = f"{norm}-{version}.data"
    wheel_path = out / f"{norm}-{version}-py3-none-{tag}.whl"
    w = WheelWriter(wheel_path, dist_info)
    exe_name = f"context-fern{suffix}"
    seen_exe = False
    for name, blob, _x in read_tar(tarball):
        if name == exe_name:
            w.add(f"{data}/scripts/{name}", blob, executable=True)
            seen_exe = True
        elif name.startswith("onnxruntime-native/"):
            # Not under scripts/: uv rejects a subdirectory there. The
            # binary's patched lookup also checks <exe-dir>/../share/context-fern/.
            w.add(f"{data}/data/share/{PRODUCT}/{name}", blob, executable=True)
        else:
            raise SystemExit(f"unexpected file in {tarball.name}: {name}")
    if not seen_exe:
        raise SystemExit(f"{tarball.name} has no {exe_name}")
    w.add(f"{norm}/__init__.py", f'__version__ = "{version}"\n'.encode())
    w.add(f"{norm}/launcher.py", LAUNCHER.encode())
    w.add(
        f"{dist_info}/METADATA",
        metadata(
            PRODUCT, version, [f"{MODEL_PRODUCT}=={model_version}"], repo_url
        ),
    )
    w.add(f"{dist_info}/WHEEL", wheel_file(f"py3-none-{tag}", purelib=False))
    w.add(
        f"{dist_info}/entry_points.txt",
        f"[console_scripts]\nfern = {norm}.launcher:main\n".encode(),
    )
    w.add(
        f"{dist_info}/licenses/LICENSE",
        (Path(__file__).resolve().parents[2] / "LICENSE").read_bytes(),
    )
    w.close()
    return wheel_path


def build_model_wheel(
    model_version: str, tarball: Path, out: Path, *, repo_url: str
) -> Path:
    norm = MODEL_PRODUCT.replace("-", "_")
    dist_info = f"{norm}-{model_version}.dist-info"
    data = f"{norm}-{model_version}.data"
    wheel_path = out / f"{norm}-{model_version}-py3-none-any.whl"
    w = WheelWriter(wheel_path, dist_info)
    for name, blob, _x in read_tar(tarball):
        # share/context-fern-model/ is found by `context-fern init` relative to the binary (../share/...).
        w.add(f"{data}/data/share/{MODEL_PRODUCT}/{name}", blob)
    w.add(
        f"{dist_info}/METADATA",
        metadata(MODEL_PRODUCT, model_version, [], repo_url),
    )
    w.add(f"{dist_info}/WHEEL", wheel_file("py3-none-any", purelib=False))
    w.add(
        f"{dist_info}/licenses/LICENSE",
        (Path(__file__).resolve().parents[2] / "LICENSE").read_bytes(),
    )
    w.close()
    return wheel_path


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--model-version", required=True)
    ap.add_argument(
        "--bundle-dir",
        type=Path,
        required=True,
        help="directory holding context-fern-<target>.tar.gz and model-*.tar.gz",
    )
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument(
        "--repo-url",
        required=True,
        help="the project URL written into the metadata (the workflow passes REPO_URL from brand.ts)",
    )
    ap.add_argument(
        "--targets",
        default="",
        help="comma-separated subset; default: every target whose tarball is in --bundle-dir",
    )
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    models = sorted(args.bundle_dir.glob("model-*.tar.gz"))
    if len(models) != 1:
        raise SystemExit(
            f"expected exactly one model-*.tar.gz in {args.bundle_dir}, found {len(models)}"
        )
    built = [
        build_model_wheel(
            args.model_version, models[0], args.out, repo_url=args.repo_url
        )
    ]
    wanted = [t for t in args.targets.split(",") if t] or [
        t for t in TARGETS if (args.bundle_dir / f"context-fern-{t}.tar.gz").exists()
    ]
    if not wanted:
        raise SystemExit(f"no context-fern-<target>.tar.gz in {args.bundle_dir}")
    for target in wanted:
        if target not in TARGETS:
            raise SystemExit(f"unknown target {target}")
        tarball = args.bundle_dir / f"context-fern-{target}.tar.gz"
        if not tarball.exists():
            raise SystemExit(f"missing {tarball}")
        built.append(
            build_platform_wheel(
                args.version,
                args.model_version,
                target,
                tarball,
                args.out,
                repo_url=args.repo_url,
            )
        )
    for p in built:
        print(f"{p.name}  {p.stat().st_size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
