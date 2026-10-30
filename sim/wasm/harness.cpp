// harness.cpp : Wasm 版の模型の口 (どのコアでも共通。JS から呼ぶ)
//
// PC の main.cpp と同じく模型とはポートだけでつながる。起動はせず、PC で保存した
// 状態 (make linux-sd-save) を読み戻して始める。保存データは JS が用意する
// (Module.stateBytes に Uint8Array で置く。gzip は JS の側で解く)。ファイルは使わない。
//
//   sim_restore()      Module.stateBytes から読み戻す。0 なら成功
//   sim_run(n)         最大 n クロック回す。stop_code が変わったらそこで返す。返り値は stop_code
//   sim_send(ch)       UART に渡す字を 1 つ足す (受信 FIFO が空き次第入る)
//   sim_out_ptr/len    UART から出た字 (sim_out_clear で捨てる)
//   sim_cycle()        模型のクロック数
//   get_ring_ptr() ... rtlscope (LogicAnalyzer) の ring と制御 (rtlscope_ring.h の RTLSCOPE_EXPORT_RING)
//
// ring には 1 クロックに 1 サンプル、6 語を書く (web/la-defs.js と合わせる):
//   語 0: [0] 退役 [1] トラップ [2] 割り込み [4:3] 特権 [5] ITLB ミス [6] DTLB ミス
//         [7] 主記憶の読み [8] 書き [9] 読みデータ [10] 書きデータ [11] UART 送信 [12] UART 受信
//         [23:16] トラップの原因 [31:24] UART の字 (送信か受信)
//   語 1: PC の下 32 ビット   語 2: 命令   語 3: 主記憶の番地の下 32 ビット
//   語 4: 主記憶のデータの下 32 ビット   語 5: tval の下 32 ビット
#include <emscripten.h>

#include <cstdint>
#include <deque>
#include <memory>
#include <string>

#include "core.h"
#include "rtlscope_ring.h"
#include "verilated_save.h"

namespace {

constexpr uint64_t kHalfPeriod = 5;   // main.cpp と同じ (timescale 1ns)
constexpr int      kRingSize   = 8192;   // サンプル数 (2 のべき乗)。PC で 25 ミリ秒ぶん
constexpr int      kRingWords  = 6;

rtlscope::Ring<kRingSize, kRingWords> g_ring;

std::unique_ptr<VerilatedContext> g_ctx;
std::unique_ptr<Vtop>             g_top;
std::deque<uint8_t>               g_in;
std::string                       g_out;

void record(bool rx, uint8_t rx_ch) {
    const Vtop& t  = *g_top;
    const bool  tx = t.uart_tx_valid;
    uint32_t    w[kRingWords];
    w[0] = (t.obs_retire ? 1u : 0u) | (t.obs_trap ? 1u << 1 : 0u) | (t.obs_trap_int ? 1u << 2 : 0u) |
           (static_cast<uint32_t>(t.obs_priv & 3) << 3) | (t.obs_itlb_miss ? 1u << 5 : 0u) |
           (t.obs_dtlb_miss ? 1u << 6 : 0u) | (t.obs_mem_rd ? 1u << 7 : 0u) | (t.obs_mem_wr ? 1u << 8 : 0u) |
           (t.obs_mem_rdata ? 1u << 9 : 0u) | (t.obs_mem_wdata ? 1u << 10 : 0u) | (tx ? 1u << 11 : 0u) |
           (rx ? 1u << 12 : 0u) | (static_cast<uint32_t>(t.obs_trap_cause) << 16) |
           (static_cast<uint32_t>(tx ? t.uart_tx_data : (rx ? rx_ch : 0)) << 24);
    w[1] = static_cast<uint32_t>(t.obs_pc);
    w[2] = t.obs_insn;
    w[3] = static_cast<uint32_t>(t.obs_mem_addr);
    w[4] = static_cast<uint32_t>(t.obs_mem_data);
    w[5] = static_cast<uint32_t>(t.obs_trap_tval);
    g_ring.record(w);
}

// Module.stateBytes の続きを dst に最大 max バイト写し、写した数を返す (尽きたら 0)
EM_JS(int, js_state_read, (uint8_t* dst, int max), {
    const src = Module.stateBytes;
    const off = Module.stateOffset || 0;
    const n = Math.min(max, src.length - off);
    HEAPU8.set(src.subarray(off, off + n), dst);
    Module.stateOffset = off + n;
    return n;
});

// VerilatedRestore のファイルの代わりに js_state_read から読む
class JsRestore final : public VerilatedDeserialize {
public:
    void open() {
        m_filename = "Module.stateBytes";
        m_isOpen   = true;
        m_cp = m_endp = m_bufp;
        header();
    }
    void close() override {
        if (!m_isOpen) return;
        trailer();
        m_isOpen = false;
    }

private:
    // VerilatedRestore::fill と同じ: 残りを頭へ寄せ、空いた所を埋め、尽きたら 0 で埋める
    void fill() override {
        uint8_t* rp = m_bufp;
        for (const uint8_t* sp = m_cp; sp < m_endp; *rp++ = *sp++) {}
        m_endp = m_bufp + (m_endp - m_cp);
        m_cp   = m_bufp;
        while (m_endp < m_bufp + bufferSize()) {
            const int got = js_state_read(m_endp, static_cast<int>(m_bufp + bufferSize() - m_endp));
            if (got <= 0) break;
            m_endp += got;
        }
        while (m_endp < m_bufp + bufferSize()) *m_endp++ = '\0';
    }
};

void tick() {
    const bool    sending = !g_in.empty() && g_top->uart_rx_ready;
    const uint8_t ch      = sending ? g_in.front() : 0;
    g_top->uart_rx_valid  = sending;
    g_top->uart_rx_data   = ch;
    g_top->clk = 1;
    g_top->eval();
    g_ctx->timeInc(kHalfPeriod);
    g_top->clk = 0;
    g_top->eval();
    g_ctx->timeInc(kHalfPeriod);
    if (sending) g_in.pop_front();
    g_top->uart_rx_valid = 0;
    if (g_top->uart_tx_valid) g_out.push_back(static_cast<char>(g_top->uart_tx_data));
    record(sending, ch);
}

}  // namespace

RTLSCOPE_EXPORT_RING(g_ring)

extern "C" {

EMSCRIPTEN_KEEPALIVE int sim_restore() {
    // initial が $value$plusargs を呼ぶので、空の引数を渡しておく (値は読み戻しで上書きされる)
    static const char* argv[] = {"sim"};
    g_ctx = std::make_unique<VerilatedContext>();
    g_ctx->commandArgs(1, argv);
    g_top = std::make_unique<Vtop>(g_ctx.get());
    // main.cpp と同じく、最初の eval (initial) を済ませてから上に書く
    g_top->clk           = 0;
    g_top->rst_n         = 0;
    g_top->uart_rx_valid = 0;
    g_top->uart_rx_data  = 0;
    g_top->eval();
    // 頭の印 (verilatorsave02) が違えば Verilator が VL_FATAL で止める
    JsRestore is;
    is.open();
    is >> g_ctx.get();
    is >> *g_top;
    is.close();
    g_top->rst_n      = 1;
    g_top->max_cycles = ~0ULL;   // 上限なし (止めるのは JS の側)
    return 0;
}

EMSCRIPTEN_KEEPALIVE int sim_run(int n) {
    const int stop0 = g_top->stop_code;
    for (int i = 0; i < n && !g_ctx->gotFinish(); i++) {
        tick();
        if (g_top->stop_code != stop0) break;
    }
    return g_top->stop_code;
}

EMSCRIPTEN_KEEPALIVE void        sim_send(int ch) { g_in.push_back(static_cast<uint8_t>(ch)); }
EMSCRIPTEN_KEEPALIVE const char* sim_out_ptr() { return g_out.data(); }
EMSCRIPTEN_KEEPALIVE int         sim_out_len() { return static_cast<int>(g_out.size()); }
EMSCRIPTEN_KEEPALIVE void        sim_out_clear() { g_out.clear(); }
EMSCRIPTEN_KEEPALIVE double      sim_cycle() { return static_cast<double>(g_top->cycle_count); }

}  // extern "C"
