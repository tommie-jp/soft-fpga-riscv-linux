#---------------------------------------------------------------------------
# Makefile : コアの模型を --timing 無しで作って回す (上の ../Makefile から呼ぶ)
#
#   make                 模型を作る (build/<コア>/obj/Vtop)
#   make CORE=<名前> ... コアを選ぶ (既定は mmrisc2)。走らせる的 (linux など) は
#                        cores/<名前>/core.mk にある
#   make state-name      保存ファイルの名前 (state/<コア>-<模型の md5>.state)
#
# 共通の物: main.cpp (時計・リセット・止める条件・UART)、console.cpp (標準入力)、
# core.h (load.cpp との境目)。
# コアごとの物: cores/<名前>/ の core.mk・トップの .sv・load.cpp。境目はトップのポート
# (README の「共通とコア別の境目」)。
#---------------------------------------------------------------------------
CORE     ?= mmrisc2
ROOT     := $(abspath $(CURDIR)/..)
CORE_DIR := $(ROOT)/cores/$(CORE)
BUILD    := $(ROOT)/build/$(CORE)
OBJ_DIR  := $(BUILD)/obj
SIM_BIN  := $(OBJ_DIR)/Vtop

.PHONY: all clean state-name state-gz wasm wasm-restore web web-serve FORCE

all: $(SIM_BIN)

include $(CORE_DIR)/core.mk

# クラスの名前はどのコアでも Vtop (--prefix)。main.cpp と load.cpp は core.h を読む。
# --savable: 起動した状態を保存して読み戻す (main.cpp の +save / +restore)
VERILATOR       := verilator
VERILATOR_FLAGS := --cc --exe --build -j 0 --top-module $(CORE_TOP) --prefix Vtop --savable \
                   -Mdir $(OBJ_DIR) -CFLAGS -I$(CURDIR) $(CORE_FLAGS)

MODEL_SRCS := $(CORE_SRCS) $(CORE_CPP) main.cpp core.h plusarg.h console.cpp console.h $(CORE_DIR)/core.mk

# 保存ファイルは模型 (Verilog) に縛られる。名前に Verilog の md5 を入れ、作り直した模型で
# 古い保存を読まないようにする (git の版だと、文書だけのコミットでも名前が変わる)。
# C++ (main.cpp など) は保存の中身に入らないので md5 に入れない
MODEL_HASH := $(shell cat $(CORE_SRCS) | md5sum | cut -c1-8)
STATE      ?= $(ROOT)/state/$(CORE)-$(MODEL_HASH).state

$(SIM_BIN): $(MODEL_SRCS)
	@mkdir -p $(BUILD)
	$(VERILATOR) $(VERILATOR_FLAGS) $(CORE_SRCS) main.cpp console.cpp $(CORE_CPP) \
	    > $(OBJ_DIR).log 2>&1 || (tail -30 $(OBJ_DIR).log; exit 1)

# Wasm 版 (Node で回す)。PC 版と同じソース・同じ旗で Verilate し、em++ でコンパイルする。
# 保存ファイルは PC 版と共用できる (中身は固定幅の値だけ)
WASM_OBJ := $(BUILD)/wasm-obj
WASM_OUT := $(BUILD)/wasm/sim.mjs

wasm: $(WASM_OUT)

$(WASM_OUT): $(CORE_SRCS) wasm/harness.cpp wasm/rtlscope_ring.h wasm/build.sh wasm/wasm_compat.h wasm/verilatedos_c.h core.h
	rm -rf $(WASM_OBJ)
	@mkdir -p $(BUILD) $(dir $(WASM_OUT))
	$(VERILATOR) --cc --top-module $(CORE_TOP) --prefix Vtop --savable -Mdir $(WASM_OBJ) \
	    $(CORE_FLAGS) $(CORE_SRCS) > $(WASM_OBJ).log 2>&1 || (tail -30 $(WASM_OBJ).log; exit 1)
	bash wasm/build.sh $(WASM_OBJ) $(WASM_OUT) >> $(WASM_OBJ).log 2>&1 || (tail -30 $(WASM_OBJ).log; exit 1)

# 配る形: gzip (ブラウザは DecompressionStream で解ける)。336 MB → 約 8 MB
$(STATE).gz: $(STATE)
	gzip -9 -k -f $<

state-gz: $(STATE).gz

# 保存した所から Wasm 版で回す。打つ行は LINES に (既定は ls)
LINES ?= ls
wasm-restore: $(WASM_OUT) $(STATE).gz
	SIM_MJS=$(WASM_OUT) node wasm/run-node.mjs $(STATE).gz $(LINES)

# ブラウザ版: dist/ に揃え、そこを HTTP で配る (make web-serve)。
# dist/index.html が目次、dist/<コア>/ がコアのページ (端末と Logic Analyzer)
WEB      := $(ROOT)/web
WEB_DIST := $(ROOT)/dist
CORE_WEB := $(WEB_DIST)/$(CORE)

web: $(WASM_OUT) $(STATE).gz $(WEB)/index.html $(WEB)/core/index.html $(WEB)/worker.js $(WEB)/la-defs.js $(wildcard $(WEB)/la/*.js)
	mkdir -p $(CORE_WEB)/la $(CORE_WEB)/licenses
	cp $(WEB)/index.html $(WEB_DIST)/
	cp $(WEB)/core/index.html $(WEB)/worker.js $(WEB)/la-defs.js $(WASM_OUT) $(WASM_OUT:.mjs=.wasm) $(CORE_WEB)/
	cp $(WEB)/la/*.js $(CORE_WEB)/la/
	cp $(STATE).gz $(CORE_WEB)/state.gz
	for f in $(CORE_LICENSES); do cp $$f $(CORE_WEB)/licenses/$(CORE)-$$(basename $$f).txt; done
	cp $(ROOT)/LICENSES/MIT-soft-fpga.txt $(CORE_WEB)/licenses/soft-fpga-LICENSE.txt
	cp $(ROOT)/LICENSE $(CORE_WEB)/licenses/soft-fpga-riscv-linux-LICENSE.txt

WEB_PORT ?= 8059
web-serve: web
	python3 -m http.server $(WEB_PORT) -d $(WEB_DIST)

clean:
	rm -rf $(BUILD) $(WEB_DIST)

state-name:
	@echo $(STATE)
