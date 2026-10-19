#!/usr/bin/env python3

"""
This script intended to fill the local conan cache with the packages required
for building the project. Clean build scenario requires running this script
before running the cmake command. Besides that, it may be also required after
the dependencies updates.

Exports use Conan directly and work with native Python on Windows; Git Bash
is not required. Git and Conan must be available on PATH.

Usage:
    bootstrap_conan_deps.py [nlc_url [dns_libs_url]]

`nlc_url` is the URL of AdGuard's NativeLibsCommon repository
(defaults to https://github.com/AdguardTeam/NativeLibsCommon.git).
`dns_libs_url` is the URL of AdGuard's DnsLibs repository
(defaults to https://github.com/AdguardTeam/DnsLibs.git).
"""

import os
import re
import shutil
import stat
import subprocess
import sys

work_dir = os.path.dirname(os.path.realpath(__file__))
project_dir = os.path.dirname(work_dir)
nlc_url = sys.argv[1] if len(sys.argv) > 1 else 'https://github.com/AdguardTeam/NativeLibsCommon.git'
nlc_dir_name = "native-libs-common"
dns_libs_url = sys.argv[2] if len(sys.argv) > 2 else 'https://github.com/AdguardTeam/DnsLibs.git'
dns_libs_dir_name = "dns-libs"
nlc_versions = []


def on_rm_tree_error(func, path, _):
    """
    Workaround for Windows behavior, where `shutil.rmtree`
    fails with an access error (read only file).
    So, attempt to add write permission and try again.
    """
    if not os.access(path, os.W_OK):
        os.chmod(path, stat.S_IWUSR)
        func(path)
    else:
        raise


def remove_dir_if_exists(dir_path):
    """Remove a directory if it exists, handling read-only files on Windows."""
    if os.path.exists(dir_path):
        os.chdir(work_dir)
        shutil.rmtree(dir_path, onerror=on_rm_tree_error)


def revision_for_version(version):
    """
    Map a Conan package version to the git revision to check out.

    Versions are produced by `git describe` and come in two shapes:
      * a plain release tag, e.g. `8.1.39`      -> check out tag `v8.1.39`
      * a snapshot `<tag>-<n>-g<rev>`, e.g.
        `2.8.58-2-g2c375f1c`                     -> check out the commit `<rev>`

    This mirrors how the dns-libs/native_libs_common recipes resolve their
    source revision. Export the exact requested version separately so snapshot
    versions do not depend on whichever tag `git describe` happens to select.
    """
    described = re.search(r"-g([0-9a-f]+)$", version)
    if described:
        return described.group(1)
    return "v" + version


def export_conan(repo_dir, version):
    """
    Export the requested NativeLibsCommon revision and its bundled recipes.

    This is the native equivalent of its scripts/export_conan.sh: the root
    package uses the exact requested version; bundled recipes retain their own
    versions declared in their conanfile.py files.
    """
    subprocess.run(["git", "-C", repo_dir, "checkout", revision_for_version(version)],
                   check=True)
    subprocess.run(["conan", "export", repo_dir, "--user", "adguard", "--channel", "oss",
                    "--version", version],
                   check=True, cwd=repo_dir)
    recipes_dir = os.path.join(repo_dir, "conan", "recipes")
    if os.path.isdir(recipes_dir):
        for name in sorted(os.listdir(recipes_dir)):
            recipe_dir = os.path.join(recipes_dir, name)
            if os.path.isdir(recipe_dir) and os.path.isfile(os.path.join(recipe_dir, "conanfile.py")):
                subprocess.run(["conan", "export", recipe_dir, "--user", "adguard", "--channel", "oss"],
                               check=True, cwd=repo_dir)


with open(os.path.join(project_dir, "conanfile.py"), "r") as file:
    for line in map(str.strip, file.readlines()):
        if line.startswith('self.requires("native_libs_common/') \
                and ('@adguard/oss"' in line):
            nlc_versions.append(line.split('@')[0].split('/')[1])
        elif line.startswith('self.requires("dns-libs/') \
                and ('@adguard/oss"' in line):
            dns_libs_version = line.split('@')[0].split('/')[1]

dns_libs_dir = os.path.join(work_dir, dns_libs_dir_name)
remove_dir_if_exists(dns_libs_dir)
try:
    subprocess.run(["git", "clone", dns_libs_url, dns_libs_dir], check=True)
    subprocess.run(["git", "-C", dns_libs_dir, "checkout",
                    revision_for_version(dns_libs_version)], check=True)
    os.chdir(dns_libs_dir)
    with open("conanfile.py", "r") as file:
        for line in map(str.strip, file.readlines()):
            if line.startswith('self.requires("native_libs_common/') \
                    and ('@adguard/oss"' in line):
                nlc_versions.append(line.split('@')[0].split('/')[1])

    subprocess.run(["conan", "export", dns_libs_dir, "--user", "adguard", "--channel", "oss",
                    "--version", dns_libs_version], check=True, cwd=dns_libs_dir)
finally:
    remove_dir_if_exists(dns_libs_dir)

os.chdir(work_dir)
nlc_dir = os.path.join(work_dir, nlc_dir_name)
remove_dir_if_exists(nlc_dir)
try:
    subprocess.run(["git", "clone", nlc_url, nlc_dir], check=True)

    seen = set()
    for v in nlc_versions:
        if v in seen:
            continue
        seen.add(v)
        export_conan(nlc_dir, v)
finally:
    remove_dir_if_exists(nlc_dir)
