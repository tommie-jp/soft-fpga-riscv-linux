#!/usr/bin/env bash
# linux-sd 用の BusyBox の木 (initramfs/) と initrd_bb を作る。
#
# mmRISC-2 の LitexSystem/README.md 4 節の手順と同じ木を作る。違いは BusyBox を
# 自分でクロスコンパイルせず、Debian 13 (trixie) の riscv64 の busybox-static
# (rv64gc の静的バイナリ) を使うこと。mmRISC-2 は Debian 13 の riscv64 が動くと
# README にあるので、同じバイナリの水準で足りる。
#
# 出力: build/rootfs/rv64-busybox/initramfs/ (木) と initrd_bb (cpio + gzip)。
# 取ってきた .deb は build/rootfs/rv64-busybox/src/ に置く
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/build/rootfs/rv64-busybox"
SRC="$OUT/src"
DEB_URL="https://deb.debian.org/debian/pool/main/b/busybox/busybox-static_1.37.0-6+b9_riscv64.deb"
DEB_SHA256="4add476d2b185c5b487c285b38d790f0881a7e4a8e2ddde835f917e770eb8633"

mkdir -p "$SRC" "$OUT"
DEB="$SRC/$(basename "$DEB_URL")"
[ -f "$DEB" ] || curl -sSfo "$DEB" "$DEB_URL"
echo "$DEB_SHA256  $DEB" | sha256sum -c -

rm -rf "$SRC/deb" && mkdir -p "$SRC/deb"
dpkg-deb -x "$DEB" "$SRC/deb"

rm -rf "$OUT/initramfs" && mkdir -p "$OUT/initramfs" && cd "$OUT/initramfs"
mkdir -p bin sbin lib etc dev home proc sys tmp mnt nfs root usr/bin usr/sbin usr/lib
cp "$SRC/deb/usr/bin/busybox" bin/   # Debian は usr/bin に置く
ln -s bin/busybox ./init
cat > etc/inittab <<'EOT'
::sysinit:/bin/busybox mount -t proc proc /proc
::sysinit:/bin/busybox mount -t devtmpfs devtmpfs /dev
::sysinit:/bin/busybox mount -t tmpfs tmpfs /tmp
::sysinit:/bin/busybox mount -t sysfs sysfs /sys
::sysinit:/bin/busybox --install -s
/dev/console::sysinit:-/bin/ash
EOT
# tb_BIOS はプロンプト "\n# " で止まる。Debian の BusyBox の既定は "~ # " で一致せず、
# 模擬が maxcycles まで空回りした (2026-10-29)
echo "PS1='# '" > etc/profile
fakeroot sh -c 'find . | cpio -H newc -o --quiet' | gzip > "$OUT/initrd_bb"
file "$OUT/initramfs/bin/busybox"
ls -la "$OUT/initrd_bb"
