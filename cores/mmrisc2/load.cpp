// load.cpp : mmRISC-2 の主記憶と ROM を書く (元の tb_BIOS.sv の #1 の後の initial)
//
//   +fw=<file>      fw_jump.bin (raw) を 0x8000_0000 に
//   +image=<file>   カーネルの Image (raw) を 0x8020_0000 に
//   +initrd=<file>  initramfs (raw) を 0x8200_0000 に (任意)
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "Vtop___024root.h"
#include "core.h"
#include "plusarg.h"

const char* const kCoreUsage = "+fw=<fw_jump.bin> +image=<Image> [+initrd=<file>] [+sdimg=<file>]";

namespace {

constexpr size_t kMemBase      = 0x80000000;
constexpr size_t kFwOffset     = 0x0000000;   // 主記憶の頭からのバイト
constexpr size_t kImageOffset  = 0x0200000;
constexpr size_t kInitrdOffset = 0x2000000;

// ROM のスタブ: addi t0,x0,1 ; slli t0,t0,31 ; addi a0,x0,0 ; addi a1,x0,0 ;
// jalr x0,0(t0) ; nop  (元の tb_BIOS.sv と同じ)
constexpr uint64_t kRomStub[] = {
    0x01f2929300100293ULL,
    0x0000059300000513ULL,
    0x0000001300028067ULL,
};

bool read_file(const std::string& path, std::vector<uint8_t>& data) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) {
        std::fprintf(stderr, "load: cannot open %s\n", path.c_str());
        return false;
    }
    uint8_t buf[1 << 16];
    size_t  n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) data.insert(data.end(), buf, buf + n);
    const bool ok = !std::ferror(f);
    std::fclose(f);
    if (!ok) std::fprintf(stderr, "load: cannot read %s\n", path.c_str());
    return ok;
}

// 主記憶 (64 ビットの語の配列、リトルエンディアン) の offset バイト目から書く
bool load(uint8_t* mem, size_t mem_bytes, size_t offset, const std::string& path) {
    std::vector<uint8_t> data;
    if (!read_file(path, data)) return false;
    if (offset + data.size() > mem_bytes) {
        std::fprintf(stderr, "load: %s (%zu bytes) does not fit at 0x%zx\n",
                     path.c_str(), data.size(), kMemBase + offset);
        return false;
    }
    std::memcpy(mem + offset, data.data(), data.size());
    std::printf("load: %s, %zu bytes at 0x%zx\n", path.c_str(), data.size(), kMemBase + offset);
    return true;
}

}  // namespace

bool core_load(VerilatedContext& ctx, Vtop& top) {
    const std::string fw     = plusarg(ctx, "fw");
    const std::string image  = plusarg(ctx, "image");
    const std::string initrd = plusarg(ctx, "initrd");
    if (fw.empty() || image.empty()) {
        std::fprintf(stderr, "load: +fw= and +image= are needed\n");
        return false;
    }

    // u_mem の initial が主記憶を連番で埋めた後なので、先に 0 にする (元と同じ)
    auto&    mem       = top.rootp->tb_mmrisc2__DOT__u_mem__DOT__mem;
    auto&    rom       = top.rootp->tb_mmrisc2__DOT__u_per__DOT__rom;
    uint8_t* mem_p     = reinterpret_cast<uint8_t*>(&mem[0]);
    const size_t mem_bytes = sizeof(mem);
    std::memset(mem_p, 0, mem_bytes);
    std::memset(&rom[0], 0, sizeof(rom));
    for (size_t i = 0; i < sizeof kRomStub / sizeof kRomStub[0]; i++) rom[i] = kRomStub[i];

    if (!load(mem_p, mem_bytes, kFwOffset, fw)) return false;
    if (!load(mem_p, mem_bytes, kImageOffset, image)) return false;
    if (!initrd.empty() && !load(mem_p, mem_bytes, kInitrdOffset, initrd)) return false;
    return true;
}
