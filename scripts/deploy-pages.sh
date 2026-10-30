#!/usr/bin/env bash
# deploy-pages.sh : ブラウザ版 (dist/) を GitHub Pages の gh-pages ブランチに置く
#
#   scripts/deploy-pages.sh <リポジトリの URL>          gh-pages に積んでコミットするまで (push しない)
#   scripts/deploy-pages.sh <リポジトリの URL> --push   そのうえで push する (公開になる)
#
# 手本は soft-FPGA の scripts/doDeployPages.sh。作業の木は scratch (既定は /tmp/soft-fpga-riscv-linux-gh-pages)。
# 置くのは make web の出力 (目次・コアごとの Wasm・state.gz・ページ・ライセンス) だけ。
# CORES (既定は mmrisc2) のコアごとに make CORE=<コア> web を回し、dist/<コア>/ を揃える。
# Pages の設定 (Settings → Pages で gh-pages の / を選ぶ) は初回に手でする。
set -euo pipefail

REPO="${1:?usage: $0 <repo url> [--push]}"
PUSH="${2-}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-/tmp/soft-fpga-riscv-linux-gh-pages}"
CORES="${CORES:-mmrisc2}"
BRANCH=gh-pages
DIST="$HERE/dist"

rm -rf "$DIST"
for core in $CORES; do
  make -C "$HERE" CORE="$core" web
done

rm -rf "$WORK"
if git ls-remote --exit-code --heads "$REPO" "$BRANCH" > /dev/null 2>&1; then
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$WORK"
else
  git init --quiet "$WORK"
  git -C "$WORK" checkout --quiet --orphan "$BRANCH"
  git -C "$WORK" remote add origin "$REPO"
fi

# 前の版の物を消してから写す (.git は残す)
find "$WORK" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r "$DIST"/. "$WORK"/
touch "$WORK/.nojekyll"   # Jekyll を通さない (そのまま配る)

git -C "$WORK" add -A
if git -C "$WORK" diff --cached --quiet; then
  echo "deploy-pages: 変更なし"
  exit 0
fi
VER="$(git -C "$HERE" describe --always --dirty)"
git -C "$WORK" commit --quiet -m "deploy: soft-fpga-riscv-linux ($VER)"
git -C "$WORK" log --oneline -1

if [ "$PUSH" = "--push" ]; then
  git -C "$WORK" push --quiet origin "$BRANCH"
  echo "deploy-pages: $REPO の $BRANCH に push した"
else
  echo "deploy-pages: $WORK にコミットした。push はしていない (公開するときは --push を付ける)"
fi
