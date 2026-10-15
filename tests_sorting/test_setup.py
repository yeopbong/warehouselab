import hashlib
import importlib.util
import subprocess
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location("setup_tmo", Path(__file__).resolve().parents[1] / "scripts/setup-tmo.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


def test_linux_header_order_preserves_flags_and_repeated_configuration(tmp_path, monkeypatch):
    monkeypatch.setenv("CXXFLAGS", "-fPIC")
    assert setup.linux_compiler_flags(tmp_path) == "-fPIC -include fmt/format.h"
    cache = tmp_path / "CMakeCache.txt"
    cache.write_text("CMAKE_CXX_FLAGS:STRING=-g -fPIC\n")
    flags = setup.linux_compiler_flags(tmp_path)
    assert flags == "-g -fPIC -include fmt/format.h"
    cache.write_text(f"CMAKE_CXX_FLAGS:STRING={flags}\n")
    assert setup.linux_compiler_flags(tmp_path) == flags
    cache.write_text("CMAKE_CXX_FLAGS:STRING=-fPIC -include spdlog/spdlog.h\n")
    assert setup.linux_compiler_flags(tmp_path) == "-fPIC -include fmt/format.h"


def git(repo, *args):
    return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


@pytest.fixture
def source(tmp_path):
    repo = tmp_path / "source"
    repo.mkdir()
    git(repo, "init", "--quiet", "--initial-branch=main")
    git(repo, "config", "user.name", "Runtime test")
    git(repo, "config", "user.email", "runtime@example.invalid")
    (repo / "core.cpp").write_text("int destination = 0;\n")
    (repo / "other.h").write_text("int other = 1;\n")
    git(repo, "add", ".")
    git(repo, "commit", "--quiet", "-m", "Initial source")
    revision = git(repo, "rev-parse", "HEAD")
    (repo / "core.cpp").write_text("int destination = 2;\n")
    patch = tmp_path / "runtime.patch"
    patch.write_text(git(repo, "diff") + "\n")
    (repo / "core.cpp").write_text("int destination = 0;\n")
    return repo, revision, patch


def test_clean_source_gets_exact_patch_and_repeated_setup_preserves_it(source):
    repo, revision, patch = source
    assert setup.verify_source(repo, revision, patch) == "clean"
    setup.apply_runtime_patch(repo, revision, patch)
    assert setup.verify_source(repo, revision, patch) == "patched"
    before = (repo / "core.cpp").stat().st_mtime_ns
    index_hash = hashlib.sha256((repo / ".git/index").read_bytes()).hexdigest()
    setup.apply_runtime_patch(repo, revision, patch)
    assert (repo / "core.cpp").stat().st_mtime_ns == before
    assert hashlib.sha256((repo / ".git/index").read_bytes()).hexdigest() == index_hash


@pytest.mark.parametrize("filename", ["core.cpp", "other.h"])
def test_extra_tracked_changes_are_rejected_without_overwriting_them(source, filename):
    repo, revision, patch = source
    setup.apply_runtime_patch(repo, revision, patch)
    changed = repo / filename
    changed.write_text(changed.read_text() + "int user_change = 7;\n")
    before = changed.read_bytes()
    with pytest.raises(RuntimeError, match="Unexpected"):
        setup.apply_runtime_patch(repo, revision, patch)
    assert changed.read_bytes() == before


@pytest.mark.parametrize("filename", ["extra.cpp", "extra.h", "notes.txt"])
def test_untracked_source_is_rejected_without_deleting_it(source, filename):
    repo, revision, patch = source
    changed = repo / filename
    changed.write_text("User content\n")
    with pytest.raises(RuntimeError, match="Untracked"):
        setup.apply_runtime_patch(repo, revision, patch)
    assert changed.read_text() == "User content\n"
    assert (repo / "core.cpp").read_text() == "int destination = 0;\n"


def test_staged_changes_cannot_hide_behind_a_clean_working_file(source):
    repo, revision, patch = source
    original = (repo / "other.h").read_text()
    (repo / "other.h").write_text("int staged_change = 3;\n")
    git(repo, "add", "other.h")
    (repo / "other.h").write_text(original)
    before = (repo / ".git/index").read_bytes()
    with pytest.raises(RuntimeError, match="staged"):
        setup.verify_source(repo, revision, patch)
    assert (repo / ".git/index").read_bytes() == before


@pytest.mark.parametrize("filename", ["src/hidden.cpp", "inc/hidden.h"])
def test_ignore_rules_cannot_hide_extra_compilation_sources(source, filename):
    repo, revision, patch = source
    changed = repo / filename
    changed.parent.mkdir()
    changed.write_text("int hidden_source = 1;\n")
    (repo / ".git/info/exclude").write_text(filename + "\n")
    with pytest.raises(RuntimeError, match="Ignored source"):
        setup.verify_source(repo, revision, patch)
    assert changed.read_text() == "int hidden_source = 1;\n"


def test_matching_revision_still_checks_upstream_changes(source):
    repo, revision, _ = source
    (repo / "other.h").write_text("int user_change = 8;\n")
    with pytest.raises(RuntimeError, match="Unexpected"):
        setup.checkout("unused", revision, repo)
    assert (repo / "other.h").read_text() == "int user_change = 8;\n"


def test_expected_submodule_changes_are_isolated_from_parent_source(source):
    repo, _, _ = source
    child = repo / "WPPL"
    child.mkdir()
    git(child, "init", "--quiet", "--initial-branch=main")
    git(child, "config", "user.name", "Runtime test")
    git(child, "config", "user.email", "runtime@example.invalid")
    (child / "core.cpp").write_text("int original = 1;\n")
    git(child, "add", ".")
    git(child, "commit", "--quiet", "-m", "Initial source")
    git(repo, "update-index", "--add", "--cacheinfo", "160000", git(child, "rev-parse", "HEAD"), "WPPL")
    git(repo, "commit", "--quiet", "-m", "Pin native source")
    revision = git(repo, "rev-parse", "HEAD")
    (child / "core.cpp").write_text("int patched = 2;\n")
    assert setup.verify_source(repo, revision, excluded_paths=("WPPL",)) == "clean"
    (repo / "other.h").write_text("int parent_change = 3;\n")
    with pytest.raises(RuntimeError, match="Unexpected"):
        setup.verify_source(repo, revision, excluded_paths=("WPPL",))
