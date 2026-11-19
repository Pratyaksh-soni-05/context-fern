"""Tests for packaging/pypi/build_wheels.py (the PyPI wheel builder).

It lives outside bench/, so it is imported by path. The checks that matter:
uv rejects a subdirectory inside a wheel's scripts/ (found by installing a
real wheel with `uvx`), RECORD must hash every file, and an archive that
tries to write outside itself is refused.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import stat
import tarfile
import zipfile
from pathlib import Path

import pytest

BUILDER = Path(__file__).resolve().parents[2] / "packaging" / "pypi" / "build_wheels.py"
spec = importlib.util.spec_from_file_location("build_wheels", BUILDER)
# Stands in for REPO_URL: the builder must write whatever it is given.
URL = "https://example.invalid/owner/project"
assert spec is not None and spec.loader is not None
build_wheels = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_wheels)


def make_tar(path: Path, files: dict[str, bytes]) -> Path:
    with tarfile.open(path, "w:gz") as t:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755
            t.addfile(info, io.BytesIO(data))
    return path


def binary_tar(tmp_path: Path, target: str) -> Path:
    suffix = ".exe" if target == "win-x64" else ""
    runtime = {"win-x64": "win32-x64", "linux-x64": "linux-x64"}.get(target, target)
    return make_tar(
        tmp_path / f"context-fern-{target}.tar.gz",
        {
            f"./context-fern{suffix}": b"binary",
            f"./onnxruntime-native/{runtime}/onnxruntime_binding.node": b"binding",
            f"./onnxruntime-native/{runtime}/lib": b"lib",
        },
    )


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()


@pytest.mark.parametrize(
    ("target", "tag"),
    [
        ("win-x64", "win_amd64"),
        ("linux-x64", "manylinux_2_28_x86_64"),
        ("linux-arm64", "manylinux_2_28_aarch64"),
        ("darwin-arm64", "macosx_14_0_arm64"),
    ],
)
def test_platform_wheel_tag_and_layout(tmp_path: Path, target: str, tag: str) -> None:
    wheel = build_wheels.build_platform_wheel(
        "0.1.0",
        "1.0.0",
        target,
        binary_tar(tmp_path, target),
        tmp_path,
        repo_url=URL,
    )
    assert wheel.name == f"context_fern-0.1.0-py3-none-{tag}.whl"
    with zipfile.ZipFile(wheel) as z:
        names = z.namelist()
        scripts = [n for n in names if ".data/scripts/" in n]
        # uv: "invalid entry (directory) in the `scripts` directory" for any nested path.
        assert scripts, "the executable must be in scripts/"
        for n in scripts:
            assert "/" not in n.split(".data/scripts/", 1)[1], n
        assert any(
            ".data/data/share/context-fern/onnxruntime-native/" in n
            and n.endswith("/onnxruntime_binding.node")
            for n in names
        )
        wheel_meta = z.read("context_fern-0.1.0.dist-info/WHEEL").decode()
        assert f"Tag: py3-none-{tag}" in wheel_meta
        assert "Root-Is-Purelib: false" in wheel_meta
        meta = z.read("context_fern-0.1.0.dist-info/METADATA").decode()
        assert "Requires-Dist: context-fern-model==1.0.0" in meta
        assert f"Home-page: {URL}" in meta
        assert f"Project-URL: Source, {URL}" in meta
        assert (
            "fern = context_fern.launcher:main"
            in z.read("context_fern-0.1.0.dist-info/entry_points.txt").decode()
        )


def test_record_hashes_every_file(tmp_path: Path) -> None:
    wheel = build_wheels.build_platform_wheel(
        "0.1.0",
        "1.0.0",
        "linux-x64",
        binary_tar(tmp_path, "linux-x64"),
        tmp_path,
        repo_url=URL,
    )
    with zipfile.ZipFile(wheel) as z:
        record = z.read("context_fern-0.1.0.dist-info/RECORD").decode().splitlines()
        listed = {line.split(",")[0]: line.split(",") for line in record}
        assert set(listed) == set(z.namelist())
        for name in z.namelist():
            if name.endswith("/RECORD"):
                assert listed[name][1:] == ["", ""]
                continue
            data = z.read(name)
            assert listed[name][1] == "sha256=" + b64(data)
            assert int(listed[name][2]) == len(data)


def test_binaries_are_executable_in_the_archive(tmp_path: Path) -> None:
    wheel = build_wheels.build_platform_wheel(
        "0.1.0",
        "1.0.0",
        "linux-x64",
        binary_tar(tmp_path, "linux-x64"),
        tmp_path,
        repo_url=URL,
    )
    with zipfile.ZipFile(wheel) as z:
        info = z.getinfo("context_fern-0.1.0.data/scripts/context-fern")
        mode = info.external_attr >> 16
        # pip marks an entry executable only if S_ISREG(mode) and an execute bit is set.
        assert stat.S_ISREG(mode)
        assert mode & 0o111


def test_model_wheel_is_pure_data_under_share(tmp_path: Path) -> None:
    tar = make_tar(
        tmp_path / "model-x.tar.gz",
        {"./Xenova/all-MiniLM-L6-v2/config.json": b"{}"},
    )
    wheel = build_wheels.build_model_wheel("1.0.0", tar, tmp_path, repo_url=URL)
    assert wheel.name == "context_fern_model-1.0.0-py3-none-any.whl"
    with zipfile.ZipFile(wheel) as z:
        assert (
            "context_fern_model-1.0.0.data/data/share/context-fern-model/"
            "Xenova/all-MiniLM-L6-v2/config.json"
        ) in z.namelist()
        assert not any(".data/scripts/" in n for n in z.namelist())
        meta = z.read("context_fern_model-1.0.0.dist-info/METADATA").decode()
        assert f"Home-page: {URL}" in meta
        assert f"Project-URL: Source, {URL}" in meta


def test_an_archive_that_escapes_is_refused(tmp_path: Path) -> None:
    tar = make_tar(tmp_path / "evil.tar.gz", {"../evil": b"x", "./context-fern": b"x"})
    with pytest.raises(SystemExit, match="unsafe path"):
        build_wheels.build_platform_wheel(
            "0.1.0", "1.0.0", "linux-x64", tar, tmp_path, repo_url=URL
        )


def test_an_unexpected_file_in_the_tarball_is_refused(tmp_path: Path) -> None:
    tar = make_tar(tmp_path / "odd.tar.gz", {"./context-fern": b"x", "./README": b"surprise"})
    with pytest.raises(SystemExit, match="unexpected file"):
        build_wheels.build_platform_wheel(
            "0.1.0", "1.0.0", "linux-x64", tar, tmp_path, repo_url=URL
        )


def test_a_tarball_without_the_binary_is_refused(tmp_path: Path) -> None:
    tar = make_tar(tmp_path / "nobin.tar.gz", {"./onnxruntime-native/linux-x64/lib": b"x"})
    with pytest.raises(SystemExit, match="has no context-fern"):
        build_wheels.build_platform_wheel(
            "0.1.0", "1.0.0", "linux-x64", tar, tmp_path, repo_url=URL
        )


def test_builds_are_reproducible(tmp_path: Path) -> None:
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    tar = binary_tar(tmp_path, "linux-x64")
    wa = build_wheels.build_platform_wheel("0.1.0", "1.0.0", "linux-x64", tar, a, repo_url=URL)
    wb = build_wheels.build_platform_wheel("0.1.0", "1.0.0", "linux-x64", tar, b, repo_url=URL)
    assert wa.read_bytes() == wb.read_bytes()
