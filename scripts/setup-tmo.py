#!/usr/bin/env python3
"""Fetch pinned simulator sources and build the native research runtime."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TMO_REV = 'c2566ac6aa7e1debd94756bb04ce7bd794d1fbed'
WPPL_REV = '4d2db54c760145e83f5d86ec4da7b512e57fc5fb'


def run(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(args, cwd=cwd, check=True)


def verify_source(target: Path, revision: str, patch: Path | None = None,
                  excluded_paths: tuple[str, ...] = ()) -> str:
    """Accept the pinned tree or that tree with exactly the supported patch."""
    target = target.resolve()
    current = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=target, text=True).strip()
    if current != revision:
        raise RuntimeError('The simulator checkout does not match its pinned revision.')
    untracked = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '-z'], cwd=target)
    if any(name and not any(name.decode().startswith(path + '/') for path in excluded_paths)
           for name in untracked.split(b'\0')):
        raise RuntimeError('Untracked simulator source files exist; use a fresh --cache directory.')
    ignored = subprocess.check_output(['git', 'ls-files', '--others', '--ignored', '--exclude-standard',
                                       '-z', '--', 'src', 'inc'], cwd=target)
    if any(Path(name.decode()).suffix.lower() in ('.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.ipp', '.tpp')
           for name in ignored.split(b'\0') if name):
        raise RuntimeError('Ignored source files exist in compilation paths; use a fresh --cache directory.')
    objects = subprocess.check_output(['git', 'rev-parse', '--git-path', 'objects'], cwd=target, text=True).strip()
    object_path = (target / objects).resolve()
    index = subprocess.check_output(['git', 'rev-parse', '--git-path', 'index'], cwd=target, text=True).strip()
    # The temporary object database keeps even validation metadata outside the source cache.
    with tempfile.TemporaryDirectory(prefix='sorting-source-') as temporary:
        git_dir = Path(temporary) / 'repository'
        subprocess.run(['git', 'init', '--quiet', '--bare', str(git_dir)], check=True)
        env = {**os.environ, 'GIT_DIR': str(git_dir), 'GIT_WORK_TREE': str(target),
               'GIT_INDEX_FILE': str(Path(temporary) / 'index'),
               'GIT_ALTERNATE_OBJECT_DIRECTORIES': str(object_path)}

        def git(*args: str) -> str:
            return subprocess.check_output(['git', *args], cwd=target, env=env, text=True).strip()

        def matches(tree: str, staged: bool = False) -> bool:
            environment = {**env, 'GIT_INDEX_FILE': str((target / index).resolve())} if staged else env
            result = subprocess.run(['git', 'diff', '--no-ext-diff', '--quiet', '--ignore-submodules=none',
                                     *(['--cached'] if staged else []),
                                     tree, '--', '.', *(f':(exclude){path}' for path in excluded_paths)],
                                    cwd=target, env=environment)
            if result.returncode not in (0, 1):
                raise RuntimeError('Unable to validate the simulator source tree.')
            return result.returncode == 0

        git('read-tree', revision)
        expected = None
        if patch is not None:
            git('apply', '--cached', str(patch.resolve()))
            expected = git('write-tree')
        if not matches(revision, staged=True) and not (expected and matches(expected, staged=True)):
            raise RuntimeError('Unexpected staged simulator changes exist; use a fresh --cache directory.')
        if matches(revision):
            return 'clean'
        if expected and matches(expected):
            return 'patched'
    raise RuntimeError('Unexpected simulator source changes exist; use a fresh --cache directory.')


def checkout(url: str, revision: str, target: Path, *, patch: Path | None = None,
             excluded_paths: tuple[str, ...] = ()) -> None:
    if not (target / '.git').exists():
        if target.exists() and any(target.iterdir()):
            raise RuntimeError('The source destination is not empty; choose a fresh --cache directory.')
        target.mkdir(parents=True, exist_ok=True)
        run('git', 'init', '--quiet', str(target))
        run('git', 'remote', 'add', 'origin', url, cwd=target)
    current = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=target,
                             capture_output=True, text=True)
    if current.stdout.strip() != revision:
        if current.returncode == 0:
            verify_source(target, current.stdout.strip(), excluded_paths=excluded_paths)
        run('git', 'fetch', '--depth=1', 'origin', revision, cwd=target)
        run('git', 'checkout', '--quiet', '--detach', revision, cwd=target)
    verify_source(target, revision, patch, excluded_paths)


def apply_runtime_patch(source: Path, revision: str, patch: Path) -> None:
    if verify_source(source, revision, patch) == 'clean':
        run('git', 'apply', '--check', str(patch), cwd=source)
        run('git', 'apply', str(patch), cwd=source)
    if verify_source(source, revision, patch) != 'patched':
        raise RuntimeError('The runtime patch did not produce the expected source tree.')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=ROOT / '.cache' / 'tmo')
    parser.add_argument('--jobs', type=int, default=min(4, os.cpu_count() or 1))
    args = parser.parse_args()
    cache = args.cache.expanduser().resolve()
    cmake = shutil.which('cmake')
    if cmake is None:
        raise RuntimeError('CMake is required. Install CMake, Boost, spdlog, and OpenMP development packages.')
    source = cache / 'source'
    checkout('https://github.com/lunjohnzhang/tmo_public.git', TMO_REV, source, excluded_paths=('WPPL',))
    wppl = source / 'WPPL'
    patch = ROOT / 'native' / 'tmo' / 'runtime.patch'
    checkout('https://github.com/lunjohnzhang/WPPL.git', WPPL_REV, wppl, patch=patch)
    apply_runtime_patch(wppl, WPPL_REV, patch)
    command = [cmake, '-S', str(ROOT / 'native' / 'tmo'), '-B', str(cache / 'build'),
               f'-DTMO_SOURCE_DIR={wppl}', '-DCMAKE_BUILD_TYPE=Release']
    if sys.platform == 'darwin':
        brew = shutil.which('brew')
        if brew:
            prefix = subprocess.check_output([brew, '--prefix'], text=True).strip()
            omp = Path(prefix) / 'opt' / 'libomp'
            command += [f'-DCMAKE_PREFIX_PATH={prefix}',
                        '-DOpenMP_CXX_FLAGS=-Xpreprocessor -fopenmp',
                        f'-DOpenMP_CXX_INCLUDE_DIR={omp / "include"}',
                        '-DOpenMP_CXX_LIB_NAMES=omp',
                        f'-DOpenMP_omp_LIBRARY={omp / "lib" / "libomp.dylib"}']
    run(*command)
    run(cmake, '--build', str(cache / 'build'), '--parallel', str(max(1, args.jobs)))
    print(f'Runtime ready: {cache / "build" / "tmo-run"}')


if __name__ == '__main__':
    main()
