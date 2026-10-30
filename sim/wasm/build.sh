#!/usr/bin/env bash
# build.sh : Verilate 済みの模型を em++ で Wasm にする (sim/Makefile の wasm が呼ぶ)
#
#   bash wasm/build.sh <Verilate した obj の場所> <出力 .mjs>
#
# 手本は soft-FPGA の scripts/build-wasm-09.sh。verilated.cpp は wasm_compat.h を -include し、
# verilatedos_c.h を差し替えてコンパイルする (どちらも soft-FPGA から写した物)。
# 同じ sim.mjs を Node でもブラウザ (Worker) でも使う。保存データは JS が Module.stateBytes に置く。
set -euo pipefail

OBJ="${1:?usage: $0 <obj dir> <out.mjs>}"
OUT="${2:?usage: $0 <obj dir> <out.mjs>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SIM="$HERE/.."
VERILATOR_ROOT="${VERILATOR_ROOT:-$(verilator --getenv VERILATOR_ROOT)}"

if ! command -v em++ > /dev/null; then
  for env in "$HOME/emsdk/emsdk_env.sh" "$HOME/emsdk/emsdk/emsdk_env.sh"; do
    # shellcheck disable=SC1090
    [ -f "$env" ] && source "$env" > /dev/null 2>&1 && break
  done
fi
command -v em++ > /dev/null || { echo "build.sh: em++ not found (emsdk)" >&2; exit 1; }

FLAGS=(-O3 -std=c++17 -DVL_IGNORE_UNKNOWN_ARCH
       -I"$VERILATOR_ROOT/include" -I"$VERILATOR_ROOT/include/vltstd" -I"$OBJ" -I"$SIM")
JOBS="$(nproc)"

# 模型の .cpp を並べてコンパイルする (1 つずつだと遅い)
find "$OBJ" -maxdepth 1 -name 'Vtop*.cpp' ! -name '*__Dpi.cpp' -print0 \
  | xargs -0 -P "$JOBS" -I{} sh -c 'em++ "$@" -c "{}" -o "{}.wasm.o"' _ "${FLAGS[@]}"

# verilated.cpp は末尾で "verilatedos_c.h" を引用符で読むので、同じ場所に差し替えを置く
mkdir -p "$OBJ/rt"
cp "$VERILATOR_ROOT/include/verilated.cpp" "$HERE/verilatedos_c.h" "$OBJ/rt/"
em++ "${FLAGS[@]}" -I"$HERE" -include "$HERE/wasm_compat.h" \
  -c "$OBJ/rt/verilated.cpp" -o "$OBJ/verilated.wasm.o"
em++ "${FLAGS[@]}" -I"$HERE" -include "$HERE/wasm_compat.h" \
  -c "$VERILATOR_ROOT/include/verilated_save.cpp" -o "$OBJ/verilated_save.wasm.o"

# 主記憶の配列だけで 256 MiB、SD カードが 64 MiB。初めから 512 MiB 取り、足りなければ伸ばす
em++ "${FLAGS[@]}" "$OBJ"/*.wasm.o "$HERE/harness.cpp" \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=node,web,worker \
  -s EXPORTED_FUNCTIONS='["_sim_restore","_sim_run","_sim_send","_sim_out_ptr","_sim_out_len","_sim_out_clear","_sim_cycle",
                          "_get_ring_ptr","_get_head","_get_ring_size","_get_ring_words",
                          "_sim_freeze_ring","_sim_thaw_ring","_sim_ring_frozen","_sim_set_la","_sim_set_post_delay",
                          "_sim_clear_trigger","_sim_set_edge_trigger","_sim_set_value_trigger",
                          "_sim_trigger_hit","_sim_trigger_fired","_sim_get_trig_fire_head",
                          "_sim_set_sample_mode","_sim_regs","_sim_regs_frozen","_sim_reg_count","_sim_regs_fire","_sim_regs_cycle"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU32"]' \
  -s INITIAL_MEMORY=536870912 -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=2147483648 \
  -s EXIT_RUNTIME=0 \
  -o "$OUT"
echo "build.sh: $OUT"
