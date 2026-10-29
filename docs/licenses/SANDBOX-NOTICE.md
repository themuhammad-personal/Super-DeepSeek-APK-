# Linux sandbox: third-party components

The Linux sandbox in Super DeepSeek (Linux Studio) is built from these
unmodified open-source components. The CI build fetches them from the Termux
package repository (`scripts/fetch_sandbox_deps.py`, checked against the
repository's SHA-256 sums). The only change is that library names inside the
binaries are renamed (for example `libtalloc.so.2` becomes `libtalloc.so`),
because Android only installs libraries named `lib*.so`.

| Component | Shipped as | License | Source |
|---|---|---|---|
| PRoot (Termux build) | `lib/<abi>/libproot.so`, `libproot-loader*.so` | GPL-2.0 | https://github.com/termux/proot, https://proot-me.github.io/ |
| talloc | `lib/<abi>/libtalloc.so` | LGPL-3.0 (Termux lists GPL-3.0) | https://talloc.samba.org/ |
| libandroid-shmem | `lib/<abi>/libandroid-shmem.so` | BSD-3-Clause | https://github.com/termux/libandroid-shmem |
| Termux packaging | build recipes | Apache-2.0 | https://github.com/termux/termux-packages |

The exact package versions used for a build are written to
`assets/sandbox/rootfs.json` inside the APK (the `proot` section) and are also
printed in the CI log.

**Alpine Linux** is not bundled. The app downloads the official Alpine
minirootfs from the Alpine mirrors the first time the sandbox is used and
checks it against the published SHA-256. Alpine packages keep their own
licenses: https://alpinelinux.org/

You can get the source code of the GPL components at the links above. If a
link stops working, open an issue in this repository and we will provide the
source of the exact versions we shipped.
