// 元: soft-FPGA (https://github.com/tommie-jp/soft-fpga) の cxx/verilatedos_c.h (soft-FPGA 9646384、2026-10-21)。手を入れずに写した
// cxx/verilatedos_c.h — Wasm 向け VlOs スタブ
//
// システムの verilatedos_c.h は pthread_getaffinity_np 等 Linux 固有 API を
// 呼び出すため、Emscripten ビルドではリンクエラーになる。
// このファイルを -I$ROOT/cxx を先頭に置くことで差し替える。
//
// verilated.cpp の末尾が `#include "verilatedos_c.h"` を行うため、
// #ifndef VL_ALLOW_VERILATEDOS_C のガードを維持する。

#ifndef VL_ALLOW_VERILATEDOS_C
#error "This file should be included only from V3Os.cpp/Verilated.cpp"
#endif

#include "verilatedos.h"
#include <cstdlib>
#include <string>

namespace VlOs {

double DeltaCpuTime::gettime() VL_MT_SAFE {
    timespec ts;
    if (0 == clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &ts))
        return ts.tv_sec + ts.tv_nsec * 1e-9;
    return 0.0;
}

double DeltaWallTime::gettime() VL_MT_SAFE {
    timespec ts;
    if (0 == clock_gettime(CLOCK_MONOTONIC, &ts))
        return ts.tv_sec + ts.tv_nsec * 1e-9;
    return 0.0;
}

uint16_t getcpu() VL_MT_SAFE { return 0; }

// Wasm はシングルスレッド。pthread_getaffinity_np は使わない。
unsigned getProcessAvailableParallelism() VL_MT_SAFE { return 1; }

unsigned getProcessDefaultParallelism() VL_MT_SAFE { return 1; }

// Wasm には /proc/self/status がない。
void memUsageBytes(uint64_t& peakr, uint64_t& currentr) VL_MT_SAFE {
    peakr = 0;
    currentr = 0;
}

std::string getenvStr(const std::string& envvar, const std::string& defaultValue) VL_MT_SAFE {
    if (const char* const v = getenv(envvar.c_str())) return v;
    return defaultValue;
}

}  // namespace VlOs
