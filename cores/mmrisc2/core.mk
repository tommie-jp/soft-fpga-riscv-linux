#---------------------------------------------------------------------------
# core.mk : mmRISC-2 (sim/Makefile が CORE=mmrisc2 で読む)
#
#   make linux      カーネルが root を待つ所まで (SD カード無し)
#   make linux-sd   SD カードの模型から BusyBox のシェルまで
#                   (LINUX_ARGS で plusarg を足す・替える)
#
# RTL と模型 (SD_MODEL・AXI4_SLAVE_MEM) は上流 (submodule の upstream/) の物をそのまま読む。
# LITEX_PERIPH だけは UART の受信を足した派生 (periph/litex/LITEX_PERIPH_RX.sv) に替える。
# ファイルの並びは upstream/SIM/SIM_BIOS/Makefile と同じ。
#---------------------------------------------------------------------------
UPSTREAM := $(CORE_DIR)/upstream
PERIPH   := $(ROOT)/periph/litex
RTL_DIR  := $(UPSTREAM)/RTL
SIM_BIOS := $(UPSTREAM)/SIM/SIM_BIOS

CORE_TOP := tb_mmrisc2

RTL_SRCS := \
	$(RTL_DIR)/CPU/CPU_DBG/DBG_CDC/DBG_CDC.sv \
	$(RTL_DIR)/CPU/CPU_DBG/DBG_CJTAG/DBG_CJTAG.sv \
	$(RTL_DIR)/CPU/CPU_DBG/DBG_DTM/DBG_DTM.sv \
	$(RTL_DIR)/CPU/CPU_DBG/DBG_DM/DBG_DM.sv \
	$(RTL_DIR)/CPU/CPU_DBG/DBG_HART_STUB/DBG_HART_STUB.sv \
	$(RTL_DIR)/CPU/CPU_DBG/DBG_BUSMST/DBG_BUSMST.sv \
	$(RTL_DIR)/CPU/CPU_DBG/CPU_DBG/CPU_DBG.sv \
	$(RTL_DIR)/CPU/CPU_DBG/DBG_CACHE/DBG_CACHE.sv \
	$(RTL_DIR)/CPU/CPU_CACHE/CACHE_TAG_ARRAY/CACHE_TAG_ARRAY.sv \
	$(RTL_DIR)/CPU/CPU_CACHE/CACHE_DATA_ARRAY/CACHE_DATA_ARRAY.sv \
	$(RTL_DIR)/CPU/CPU_L2/L2_TAG_ARRAY.sv \
	$(RTL_DIR)/CPU/CPU_L2/CPU_L2.sv \
	$(RTL_DIR)/CPU/CPU_CACHE/ICACHE/ICACHE.sv \
	$(RTL_DIR)/CPU/CPU_CACHE/DCACHE/DCACHE.sv \
	$(RTL_DIR)/CPU/CPU_CACHE/CACHE_PORT_ARB/CACHE_PORT_ARB.sv \
	$(RTL_DIR)/CPU/CPU_CACHE/CPU_CACHE/CPU_CACHE.sv \
	$(RTL_DIR)/CPU/CPU_MMU/MMU_PMP/MMU_PMP.sv \
	$(RTL_DIR)/CPU/CPU_MMU/MMU_TLB/MMU_TLB.sv \
	$(RTL_DIR)/CPU/CPU_MMU/MMU_PTW/MMU_PTW.sv \
	$(RTL_DIR)/CPU/CPU_MMU/CORE_MMU/CORE_MMU.sv \
	$(RTL_DIR)/CPU/CPU_CORE/CORE_DEC/CORE_DEC.sv \
	$(RTL_DIR)/CPU/CPU_CORE/CORE_DECOMP/CORE_DECOMP.sv \
	$(RTL_DIR)/CPU/CPU_CORE/CORE_CSR/CORE_CSR.sv \
	$(RTL_DIR)/CPU/CPU_CORE/CORE_MDU/CORE_MDU.sv \
	$(RTL_DIR)/CPU/CPU_CORE/CORE_FRF/CORE_FRF.sv \
	$(RTL_DIR)/CPU/CPU_FPU/FPU_ROUND/FPU_ROUND.sv \
	$(RTL_DIR)/CPU/CPU_FPU/FPU_PIPE/FPU_PIPE.sv \
	$(RTL_DIR)/CPU/CPU_CORE/CORE_RF/CORE_RF.sv \
	$(RTL_DIR)/CPU/CPU_CORE/CORE_BTB/CORE_BTB.sv \
	$(RTL_DIR)/CPU/CPU_CORE/CORE_IFU/CORE_IFU.sv \
	$(RTL_DIR)/CPU/CPU_CORE/CORE_EXU/CORE_EXU.sv \
	$(RTL_DIR)/CPU/CPU_CORE/CORE_LSU/CORE_LSU.sv \
	$(RTL_DIR)/CPU/CPU_CORE/CPU_CORE/CPU_CORE.sv \
	$(RTL_DIR)/CPU/CPU_CLINT/CPU_CLINT.sv \
	$(RTL_DIR)/CPU/CPU_PLIC/CPU_PLIC.sv \
	$(RTL_DIR)/CPU/CPU_MMIO/CPU_MMIO.sv \
	$(RTL_DIR)/BUS/BUS_ARB/BUS_ARB.sv \
	$(RTL_DIR)/CPU/CPU_DMA/DMA_CACHE.sv \
	$(RTL_DIR)/CPU/CPU_BFM/CPU_BFM.sv \
	$(RTL_DIR)/CPU/CPU_TOP/CPU_TOP.sv

# public.vlt: load.cpp が書く配列 (mem・rom) を、上流のファイルを書き換えずに public にする
CORE_SRCS := $(CORE_DIR)/public.vlt $(RTL_SRCS) \
             $(UPSTREAM)/SIM/SIM_SYS/AXI4_SLAVE_MEM.sv $(PERIPH)/LITEX_PERIPH_RX.sv \
             $(SIM_BIOS)/SD_MODEL.sv $(CORE_DIR)/$(CORE_TOP).sv
CORE_CPP  := $(CORE_DIR)/load.cpp

# ブラウザ版に添えるライセンス (make web が dist/mmrisc2/licenses/mmrisc2-<名前>.txt に写す)
CORE_LICENSES := $(UPSTREAM)/LICENSE $(UPSTREAM)/NOTICE

# 上流の旗のうち警告の分 (--binary --timing は sim/Makefile が --cc --exe --build に替える)
CORE_FLAGS := -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-UNUSEDSIGNAL \
              -Wno-UNUSEDPARAM -Wno-DECLFILENAME -Wno-PINCONNECTEMPTY \
              -Wno-BLKSEQ -Wno-MULTIDRIVEN -Wno-UNDRIVEN -Wno-fatal

FW_BIN    := $(UPSTREAM)/LitexSystem/software/boot/fw_jump.bin
IMAGE_BIN := $(UPSTREAM)/LitexSystem/software/boot/Image

# 上限は 4 億クロック (シェルは約 3.3 億で出る)
LINUX_ARGS ?= +pcmon=10000000 +uart_cycles=20 +maxcycles=400000000

# SD カードの像は上流の Makefile で作る (産物は上流の .gitignore で外れている)。
# rootfs は make rootfs (rootfs/rv64-busybox/make-rootfs.sh) が作る木
ROOTFS      := $(ROOT)/build/rootfs/rv64-busybox
ROOTFS_VARS := ROOTFS_SRC=$(ROOTFS)/initramfs INITRD_BIN=$(ROOTFS)/initrd_bb
SDCARD      := $(SIM_BIOS)/sdcard.img

.PHONY: linux linux-sd linux-sd-save restore

$(SDCARD): FORCE
	$(MAKE) -C $(SIM_BIOS) $(ROOTFS_VARS) sdcard.img

linux: $(SIM_BIN)
	$(SIM_BIN) +fw=$(FW_BIN) +image=$(IMAGE_BIN) $(LINUX_ARGS)

# SD_MODEL は像を配列に読み込むだけで、ファイルには書き戻さない。上流のように写しは取らない
linux-sd: $(SIM_BIN) $(SDCARD)
	$(SIM_BIN) +fw=$(FW_BIN) +image=$(IMAGE_BIN) +sdimg=$(SDCARD) $(LINUX_ARGS)

# 最初のプロンプトで $(STATE) に保存し、そのまま続ける (標準入力の行を打つ)
linux-sd-save: $(SIM_BIN) $(SDCARD)
	@mkdir -p $(dir $(STATE))
	$(SIM_BIN) +fw=$(FW_BIN) +image=$(IMAGE_BIN) +sdimg=$(SDCARD) +save=$(STATE) $(LINUX_ARGS)

# $(STATE) から始める。上限は 15 億クロック (端末で対話して、PC で約 50 分)。パイプで行を流す時は
# 最後のプロンプトで止まる。+uart_cycles・+pcmon は模型の中の値なので、保存した時の値のまま
RESTORE_ARGS ?= +maxcycles=1500000000
restore: $(SIM_BIN)
	$(SIM_BIN) +restore=$(STATE) $(RESTORE_ARGS)
