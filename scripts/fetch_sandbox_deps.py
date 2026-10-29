#!/usr/bin/env python3
"""Fetch the native pieces of the Linux sandbox into the Android build.

  * proot + its loaders + every shared library it needs (libtalloc,
    libandroid-shmem, ...) from the Termux package repository
    (GPL-2.0 / LGPL-3.0), for every ABI the app ships, into
    android/app/src/main/jniLibs/<abi>/ as lib*.so so the package manager
    extracts them into nativeLibraryDir, the one app-owned place Android
    still lets an app exec() from.
  * a manifest of the current Alpine minirootfs (URL + SHA-256 per arch) into
    android/app/src/main/assets/sandbox/rootfs.json. The rootfs itself is
    downloaded by the app on first use, not bundled.

Everything is verified against SHA-256 sums published by the repositories
over HTTPS. Mirrors are tried in order. Outputs are gitignored; CI runs this
before Gradle. Standard library only.

Usage: python3 scripts/fetch_sandbox_deps.py [--out android/app/src/main]
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import lzma
import os
import sys
import tarfile
import time
import urllib.request

TERMUX_MIRRORS = [
    "https://packages-cf.termux.dev/apt/termux-main",
    "https://packages.termux.dev/apt/termux-main",
    "https://grimler.se/termux/termux-main",
    "https://mirror.mwt.me/termux/main",
]
ALPINE_MIRRORS = [
    "https://dl-cdn.alpinelinux.org/alpine",
    "https://mirrors.edge.kernel.org/alpine",
    "https://mirror.leaseweb.com/alpine",
]
# Android ABI -> (Termux arch, Alpine arch)
ABIS = {
    "arm64-v8a": ("aarch64", "aarch64"),
    "armeabi-v7a": ("arm", "armv7"),
    "x86_64": ("x86_64", "x86_64"),
    "x86": ("i686", "x86"),
}
TERMUX_PREFIX = "data/data/com.termux/files/usr/"


def log(msg: str) -> None:
    print(f"[sandbox-deps] {msg}", flush=True)


def fetch(url: str, attempts: int = 3) -> bytes:
    last: Exception | None = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "superdeepseek-ci"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - retry any network error
            last = e
            time.sleep(1 + i * 2)
    raise RuntimeError(f"{url}: {last}")


def fetch_any(urls: list[str]) -> tuple[str, bytes]:
    errors = []
    for u in urls:
        try:
            return u, fetch(u)
        except Exception as e:  # noqa: BLE001
            errors.append(str(e))
    raise RuntimeError("all mirrors failed:\n  " + "\n  ".join(errors))


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------- Termux ---

def parse_packages(text: str) -> dict[str, dict[str, str]]:
    pkgs: dict[str, dict[str, str]] = {}
    for stanza in text.split("\n\n"):
        fields: dict[str, str] = {}
        for line in stanza.splitlines():
            if ":" in line and not line.startswith(" "):
                k, v = line.split(":", 1)
                fields[k.strip()] = v.strip()
        if "Package" in fields:
            pkgs[fields["Package"]] = fields
    return pkgs


def termux_index(arch: str) -> tuple[str, dict[str, dict[str, str]]]:
    errors = []
    for mirror in TERMUX_MIRRORS:
        base = f"{mirror}/dists/stable/main/binary-{arch}/Packages"
        for suffix, decode in (("", lambda b: b), (".xz", lzma.decompress)):
            try:
                raw = decode(fetch(base + suffix, attempts=2))
                return mirror, parse_packages(raw.decode("utf-8", "replace"))
            except Exception as e:  # noqa: BLE001
                errors.append(f"{base}{suffix}: {e}")
    raise RuntimeError("no Termux index:\n  " + "\n  ".join(errors))


def ar_members(deb: bytes) -> dict[str, bytes]:
    if not deb.startswith(b"!<arch>\n"):
        raise ValueError("not a .deb (ar) archive")
    pos, out = 8, {}
    while pos + 60 <= len(deb):
        hdr = deb[pos:pos + 60]
        name = hdr[0:16].decode().strip().rstrip("/")
        size = int(hdr[48:58].decode().strip())
        pos += 60
        out[name] = deb[pos:pos + size]
        pos += size + (size & 1)
    return out


def deb_files(deb: bytes) -> dict[str, tarfile.TarFile | bytes]:
    members = ar_members(deb)
    data_name = next(n for n in members if n.startswith("data.tar"))
    tf = tarfile.open(fileobj=io.BytesIO(members[data_name]), mode="r:*")
    files: dict[str, bytes] = {}
    links: dict[str, str] = {}
    for m in tf.getmembers():
        name = m.name.lstrip("./")
        if m.isfile():
            files[name] = tf.extractfile(m).read()  # type: ignore[union-attr]
        elif m.issym():
            links[name] = m.linkname
    # Resolve symlinks (libtalloc.so.2 -> libtalloc.so.2.4.x) to contents.
    for name, target in links.items():
        resolved = os.path.normpath(os.path.join(os.path.dirname(name), target)) if not target.startswith("/") else target.lstrip("/")
        if resolved in files:
            files[name] = files[resolved]
    return files  # type: ignore[return-value]


def patch_cstring(blob: bytes, old: bytes, new: bytes) -> bytes:
    """Same-length, in-place rename of a NUL-terminated string (no ELF relayout)."""
    assert len(new) <= len(old)
    needle = b"\0" + old + b"\0"
    if needle not in blob:
        return blob
    return blob.replace(needle, b"\0" + new + b"\0" * (len(old) - len(new) + 1))


# ------------------------------------------------------------------- ELF ---

def elf_dynamic(blob: bytes) -> tuple[list[str], str | None]:
    """(DT_NEEDED names, DT_SONAME) of an ELF file; ([], None) for static ones."""
    import struct
    if blob[:4] != b"\x7fELF":
        raise ValueError("not an ELF file")
    is64 = blob[4] == 2
    end = "<" if blob[5] == 1 else ">"
    if is64:
        e_phoff, = struct.unpack_from(end + "Q", blob, 0x20)
        e_phentsize, e_phnum = struct.unpack_from(end + "HH", blob, 0x36)
    else:
        e_phoff, = struct.unpack_from(end + "I", blob, 0x1C)
        e_phentsize, e_phnum = struct.unpack_from(end + "HH", blob, 0x2A)
    loads, dyn = [], None
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        if is64:
            p_type, _flags, p_offset, p_vaddr, _pa, p_filesz = struct.unpack_from(end + "IIQQQQ", blob, off)
        else:
            p_type, p_offset, p_vaddr, _pa, p_filesz = struct.unpack_from(end + "IIIII", blob, off)
        if p_type == 1:
            loads.append((p_vaddr, p_offset, p_filesz))
        elif p_type == 2:
            dyn = (p_offset, p_filesz)
    if dyn is None:
        return [], None
    fmt, size = (end + "qQ", 16) if is64 else (end + "iI", 8)
    entries = []
    for off in range(dyn[0], dyn[0] + dyn[1], size):
        tag, val = struct.unpack_from(fmt, blob, off)
        if tag == 0:
            break
        entries.append((tag, val))
    strtab = next((v for t, v in entries if t == 5), None)
    if strtab is None:
        return [], None
    base = next((o + (strtab - va) for va, o, sz in loads if va <= strtab < va + sz), strtab)

    def cstr(o: int) -> str:
        return blob[base + o: blob.index(b"\0", base + o)].decode()
    needed = [cstr(v) for t, v in entries if t == 1]
    soname = next((cstr(v) for t, v in entries if t == 14), None)
    return needed, soname


def elf_load_align(blob: bytes) -> int:
    """The largest p_align of the PT_LOAD segments (0 when unknown).

    Android 15+ devices can use 16 KB memory pages, and every loadable segment
    of a 64-bit library must then be aligned to 16 KB (0x4000) or the loader
    refuses the file. Termux still ships libraries linked for 4 KB pages, so this
    is measured here, reported loudly, and never silently assumed.
    """
    import struct
    if blob[:4] != b"\x7fELF":
        return 0
    is64 = blob[4] == 2
    end = "<" if blob[5] == 1 else ">"
    try:
        if is64:
            e_phoff, = struct.unpack_from(end + "Q", blob, 0x20)
            e_phentsize, e_phnum = struct.unpack_from(end + "HH", blob, 0x36)
            fmt = end + "IIQQQQQQ"
        else:
            e_phoff, = struct.unpack_from(end + "I", blob, 0x1C)
            e_phentsize, e_phnum = struct.unpack_from(end + "HH", blob, 0x2A)
            fmt = end + "IIIIIIII"
    except struct.error:
        return 0
    align = 0
    for i in range(e_phnum):
        try:
            fields = struct.unpack_from(fmt, blob, e_phoff + i * e_phentsize)
        except struct.error:
            return align
        if fields[0] != 1:  # PT_LOAD
            continue
        p_align = fields[7] if is64 else fields[6]
        align = max(align, p_align)
    return align


PAGE_16K = 0x4000
SIXTEEN_KB_ABIS = {"arm64-v8a", "x86_64"}


def should_ship_loader32(abi: str, blob: bytes) -> bool:
    """64-bit Android ABIs use 64-bit Alpine guests and must not package a
    4 KB-aligned 32-bit helper into jniLibs/<abi>/, which breaks 16 KB APK
    alignment on Android 15+."""
    if abi not in SIXTEEN_KB_ABIS:
        return True
    align = elf_load_align(blob)
    return align == 0 or align >= PAGE_16K


# Libraries every Android device provides to apps (NDK stable system libs).
ANDROID_SYSTEM_LIBS = {
    "libc.so", "libm.so", "libdl.so", "liblog.so", "libz.so", "libandroid.so",
    "libstdc++.so", "libjnigraphics.so", "libEGL.so", "libGLESv2.so",
    "libOpenSLES.so", "libmediandk.so", "libnativewindow.so", "libvulkan.so",
}


def android_name(soname: str) -> str:
    """libfoo.so.2.4 -> libfoo.so (the only names Android installs from an APK)."""
    i = soname.find(".so")
    return soname[: i + 3] if i >= 0 else soname


def dep_names(field: str) -> list[str]:
    out = []
    for part in field.split(","):
        alt = part.split("|")[0].strip()
        name = alt.split("(")[0].strip()
        if name:
            out.append(name)
    return out


def fetch_proot(out_dir: str) -> dict:
    """proot, its loaders, and every shared library it needs (the whole
    Termux dependency closure), renamed to lib*.so, and checked: each
    DT_NEEDED must resolve to a shipped library or an Android system one,
    otherwise the build fails here instead of on the phone."""
    notice = {}
    for abi, (arch, _) in ABIS.items():
        mirror, pkgs = termux_index(arch)
        got: dict[str, bytes] = {}
        versions: dict[str, str] = {}
        queue, seen = ["proot"], set()
        while queue:
            pkg = queue.pop(0)
            if pkg in seen:
                continue
            seen.add(pkg)
            meta = pkgs.get(pkg)
            if not meta:
                raise RuntimeError(f"{pkg} missing from the Termux index for {arch}")
            urls = [f"{m}/{meta['Filename']}" for m in [mirror] + [x for x in TERMUX_MIRRORS if x != mirror]]
            url, deb = fetch_any(urls)
            if sha256(deb) != meta["SHA256"].lower():
                raise RuntimeError(f"SHA-256 mismatch for {url}")
            versions[pkg] = meta["Version"]
            files = deb_files(deb)
            if pkg == "proot":
                got["libproot.so"] = files[TERMUX_PREFIX + "bin/proot"]
                loader = files.get(TERMUX_PREFIX + "libexec/proot/loader")
                if loader is None:
                    raise RuntimeError(f"proot loader missing for {arch}")
                got["libproot-loader.so"] = loader
                loader32 = files.get(TERMUX_PREFIX + "libexec/proot/loader32")
                if loader32 is not None and should_ship_loader32(abi, loader32):
                    got["libproot-loader32.so"] = loader32
                elif loader32 is not None:
                    log(f"{abi}: skipping optional 32-bit libproot-loader32.so (4 KB aligned; {abi} guest is 64-bit)")
            else:
                for name, data in files.items():
                    if not name.startswith(TERMUX_PREFIX + "lib/") or "/" in name[len(TERMUX_PREFIX + "lib/"):]:
                        continue
                    base = os.path.basename(name)
                    if ".so" not in base or not isinstance(data, bytes) or data[:4] != b"\x7fELF":
                        continue
                    _, soname = elf_dynamic(data)
                    target = android_name(soname or base)
                    # Prefer the file the SONAME points at (libfoo.so.2 over libfoo.so).
                    if target not in got or (soname and base == soname):
                        got[target] = data
            queue.extend(d for d in dep_names(meta.get("Depends", "")) if d not in seen)

        # Rename versioned DT_NEEDED / DT_SONAME strings to the lib*.so names
        # Android installs, in place, then prove every dependency resolves.
        renames: dict[str, str] = {}
        for name, data in got.items():
            needed, soname = elf_dynamic(data)
            for n in needed + ([soname] if soname else []):
                if android_name(n) != n:
                    renames[n] = android_name(n)
        for name in list(got):
            for old, new in renames.items():
                got[name] = patch_cstring(got[name], old.encode(), new.encode())
        # Drop libraries nothing needs (keeps the APK small).
        wanted, stack = set(), ["libproot.so"]
        while stack:
            cur = stack.pop()
            if cur in wanted:
                continue
            wanted.add(cur)
            for n in elf_dynamic(got[cur])[0]:
                if n in got:
                    stack.append(n)
                elif n not in ANDROID_SYSTEM_LIBS:
                    raise RuntimeError(f"{abi}: {cur} needs {n}, which is neither shipped nor an Android system library")
        wanted |= {n for n in got if n.startswith("libproot-loader")}
        got = {n: d for n, d in got.items() if n in wanted}

        dest = os.path.join(out_dir, "jniLibs", abi)
        os.makedirs(dest, exist_ok=True)
        for name, data in got.items():
            with open(os.path.join(dest, name), "wb") as f:
                f.write(data)
            os.chmod(os.path.join(dest, name), 0o755)
        # 16 KB page-size readiness (Android 15+ devices; Google Play refuses
        # updates without it from 2027-02-01). Measured, printed, not assumed.
        aligns = {name: elf_load_align(data) for name, data in got.items()}
        misaligned = sorted(n for n, a in aligns.items() if 0 < a < PAGE_16K)
        page_16k = not misaligned
        if page_16k:
            log(f"{abi}: 16 KB page size: OK (every library is 16 KB aligned)")
        else:
            log(f"{abi}: 16 KB page size: NOT READY - {len(misaligned)} librar"
                f"{'y is' if len(misaligned) == 1 else 'ies are'} only 4 KB aligned "
                f"({', '.join(misaligned)}). These do not load on 16 KB-page devices; "
                f"upstream Termux has to relink them.")
        log(f"[sandbox-deps] page-size: {abi}={'16kb' if page_16k else '4kb'}")
        notice[abi] = {"arch": arch, "mirror": mirror, "pageSize16k": page_16k,
                       "loadAlign": {n: a for n, a in aligns.items()}, **versions}
        deps = {n: elf_dynamic(d)[0] for n, d in got.items()}
        log(f"{abi}: {', '.join(f'{k} {v}' for k, v in versions.items())}")
        for n, d in sorted(deps.items()):
            log(f"  {n}: needs {', '.join(d) or '(static)'}")
    return notice


# ---------------------------------------------------------------- Alpine ---

def parse_releases_yaml(text: str) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    cur: dict[str, str] | None = None
    for line in text.splitlines():
        s = line.strip()
        if s == "-" or s.startswith("- "):
            cur = {}
            items.append(cur)
            s = s[1:].strip()
        if cur is not None and ":" in s:
            k, v = s.split(":", 1)
            cur[k.strip()] = v.strip().strip('"')
    return items


def fetch_rootfs_manifest() -> dict:
    manifest: dict = {"distro": "alpine", "arches": {}}
    for abi, (_, arch) in ABIS.items():
        urls = [f"{m}/latest-stable/releases/{arch}/latest-releases.yaml" for m in ALPINE_MIRRORS]
        _, raw = fetch_any(urls)
        rel = next((i for i in parse_releases_yaml(raw.decode()) if i.get("flavor") == "alpine-minirootfs"), None)
        if not rel:
            raise RuntimeError(f"no alpine-minirootfs for {arch}")
        branch = rel.get("branch") or "latest-stable"
        path = f"{branch}/releases/{arch}/{rel['file']}"
        manifest["arches"][abi] = {
            "arch": arch,
            "version": rel.get("version", ""),
            "sha256": rel["sha256"].lower(),
            "size": int(rel.get("size", "0") or 0),
            "urls": [f"{m}/{path}" for m in ALPINE_MIRRORS],
        }
        manifest["version"] = rel.get("version", "")
        log(f"{abi}: alpine-minirootfs {rel.get('version')} ({rel['file']})")
    return manifest


def _fake_elf64(p_align: int, loads: int = 2, phoff: int = 64) -> bytes:
    """A minimal ELF64 header plus `loads` PT_LOAD program headers (for --self-test)."""
    import struct
    blob = bytearray(phoff + loads * 56)
    blob[0:4] = b"\x7fELF"
    blob[4] = 2        # 64-bit
    blob[5] = 1        # little endian
    struct.pack_into("<Q", blob, 0x20, phoff)          # e_phoff
    struct.pack_into("<HH", blob, 0x36, 56, loads)     # e_phentsize, e_phnum
    for i in range(loads):
        off = phoff + i * 56
        struct.pack_into("<IIQQQQQQ", blob, off, 1, 5, 0, 0, 0, 0, 0, p_align)
    return bytes(blob)


def self_test() -> int:
    """Checks the page-size measurement itself (no network)."""
    assert elf_load_align(_fake_elf64(0x1000)) == 0x1000, "4 KB alignment not read"
    assert elf_load_align(_fake_elf64(0x4000)) == 0x4000, "16 KB alignment not read"
    assert elf_load_align(_fake_elf64(0x1000, loads=1)) == 0x1000
    # A larger alignment among several segments wins.
    import struct
    blob = bytearray(_fake_elf64(0x1000, loads=2))
    struct.pack_into("<IIQQQQQQ", blob, 64 + 56, 1, 5, 0, 0, 0, 0, 0, 0x4000)
    assert elf_load_align(bytes(blob)) == 0x4000, "max alignment not taken"
    # Non-ELF and truncated input must return 0, never raise.
    assert elf_load_align(b"not an elf") == 0
    assert elf_load_align(_fake_elf64(0x4000)[:40]) == 0
    assert elf_load_align(b"") == 0
    # Sanity: the classic antlr/cpython constants this project cares about.
    assert PAGE_16K == 0x4000 and android_name("libfoo.so.2") == "libfoo.so"
    assert not should_ship_loader32("arm64-v8a", _fake_elf64(0x1000))
    assert not should_ship_loader32("x86_64", _fake_elf64(0x1000))
    assert should_ship_loader32("arm64-v8a", _fake_elf64(0x4000))
    assert should_ship_loader32("armeabi-v7a", _fake_elf64(0x1000))
    print("[sandbox-deps] self-test passed: ELF page-size measurement")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "android", "app", "src", "main"))
    ap.add_argument("--self-test", action="store_true", help="check the ELF page-size reader, no network")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    out = os.path.abspath(args.out)

    notice = fetch_proot(out)
    manifest = fetch_rootfs_manifest()
    assets = os.path.join(out, "assets", "sandbox")
    os.makedirs(assets, exist_ok=True)
    manifest["proot"] = notice
    with open(os.path.join(assets, "rootfs.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    log(f"wrote {os.path.join(assets, 'rootfs.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
