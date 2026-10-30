// 元: soft-FPGA (https://github.com/tommie-jp/soft-fpga) の cxx/wasm_compat.h (soft-FPGA 9646384、2026-10-21)。手を入れずに写した
// cxx/wasm_compat.h — Verilator/Emscripten 互換 shim
//
// 使い方: verilated.cpp のコンパイルにのみ -include で適用する。
//
//   em++ -include cxx/wasm_compat.h -c verilated.cpp -o verilated.wasm.o

#pragma once

// verilated_threads.h / verilated_trace.h の include guard を先取りして
// ホスト依存ヘッダの取り込みを防ぐ。
#define VERILATOR_VERILATED_THREADS_H_
#define VERILATOR_VERILATED_TRACE_H_

// verilatedos_c.h 内の pthread_getaffinity_np 呼び出しを防ぐ。
// Emscripten は __linux を定義するため CPU affinity ブロックがコンパイルされてしまう。
// Wasm はシングルスレッドなので CPU カウントは不要。
#undef __linux
#undef CPU_ZERO

#include "verilated.h"

// verilated.cpp が verilated_threads.h から要求する型
// (シングルスレッドでも型定義が必要)
class VlThreadPool : public VerilatedVirtualBase {
public:
    VlThreadPool(VerilatedContext*, unsigned) {}
    ~VlThreadPool() override = default;
};

// verilated.cpp が verilated_trace.h から要求する型
class VerilatedTraceBaseC {
public:
    bool isOpen() const { return false; }
    bool modelConnected() const { return false; }
    void modelConnected(bool) {}
};

class VerilatedTraceConfig {};
