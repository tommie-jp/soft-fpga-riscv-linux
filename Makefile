#---------------------------------------------------------------------------
# Makefile : make CORE=<コア> <的> を sim/Makefile に渡す
#
#   make rootfs                  RV64 の BusyBox の木 (build/rootfs/rv64-busybox/)
#   make linux-sd-save           起動して最初のプロンプトで保存 (約 14 分、1 度だけ)
#   make restore                 保存した所から、端末で対話 (Ctrl-] で終わる)
#   make web-serve               ブラウザ版を http://localhost:8059/ で配る
#
# CORE の既定は mmrisc2。ほかの的は sim/Makefile と cores/<コア>/core.mk を見る。
#---------------------------------------------------------------------------
.PHONY: rootfs FORCE

rootfs:
	rootfs/rv64-busybox/make-rootfs.sh

%: FORCE
	$(MAKE) -C sim $@

# 的を書かないときは模型を作る
.DEFAULT_GOAL := all
all: FORCE
	$(MAKE) -C sim all

FORCE: ;
Makefile: ;   # % の的で自分自身を作り直そうとしない
