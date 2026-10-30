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
//   sim_set_sample_mode(m)  ring に書く時: 0 毎クロック、1 事象のあるクロックだけ (退役・トラップ・UART・
//                      2 つ目の書き込み、または kSlowMask の信号が前のクロックから変わった時)
//   sim_regs()         レジスタの窓 (kRegCount 個の 64 ビット) を読んで、その場所を返す。ring が止まって
//                      いれば、止まった時の値 (止まった直後に写した物) を返す
//   sim_regs_frozen()  sim_regs が止まった時の値なら 1
//   sim_regs_fire()    トリガーが発火したサンプルを記録した直後のレジスタの窓 (発火していなければ 0)。
//                      止まった時の値と合わせて、ページが ring の各時点のレジスタを組み立てる手掛かりにする
//   sim_regs_cycle()   sim_regs の写しを取った時のクロック数。最後のサンプルのクロック数と同じなら、写しは
//                      そのサンプルで書いたレジスタをまだ含まない (書き戻しは次の立ち上がりで入る)。
//                      「事象のあるクロックだけ」で Hold すると、記録の無いクロックが挟まって含むことがある
//   sim_regs_fire の写しは、発火したサンプルで書いたレジスタをまだ含まない
//
// ring には 1 サンプルに 17 語を書く (web/la-defs.js と合わせる):
//   語 0: [0] 退役 [1] トラップ [2] 割り込み [4:3] 特権 [5] ITLB ミス [6] DTLB ミス
//         [7] 主記憶の読み [8] 書き [9] 読みデータ [10] 書きデータ [11] UART 送信 [12] UART 受信
//         [13] rd に書いた [14] トラップが S へ [15] I$ への読み
//         [22:16] トラップの原因 [23] 割り込みなら 1 (mcause の最上位と同じ意味)。トラップでないクロックは 0x7f [31:24] UART の字 (送信か受信)
//   語 1: PC の下 32 ビット   語 2: 命令   語 3: 主記憶の番地の下 32 ビット
//   語 4: 主記憶のデータの下 32 ビット   語 5: tval の下 32 ビット
//   語 6・7: rd に書いた値の下・上 32 ビット   語 8: 性能の事象 (obs_events)
//   語 9: [4:0] rd [8:5] 割り込みの線 (M soft・M timer・M ext・S ext) [9] 割り込みが待っている
//         [10] mstatus.SIE [11] mstatus.MIE [12] D$ への読み書き [17:13] その種類 [25:18] SoC (obs_dev)
//         [26] 途切れの後の最初のサンプル (止めていた間や LA OFF の間も模型は回るので、前のサンプルとの間に
//              記録の無いクロックがある。ページはここをまたいでレジスタを組み立てない)
//         [31:27] 2 つ目の書き込みのレジスタ (0 なら書いていない。x0 には書かない)
//   語 10: satp の下 32 ビット   語 11: epc の下 32 ビット   語 12: D$ への番地 (仮想) の下 32 ビット
//   語 13: [15:0] mip [31:16] mie   語 14: クロック数の下 32 ビット
//   語 15・16: 2 つ目の書き込みの値の下・上 32 ビット (obs_rd2_data)
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
constexpr int      kRingSize   = 16384;  // サンプル数 (2 のべき乗)
constexpr int      kRingWords  = 17;
constexpr int      kRegCount   = 89;     // レジスタの窓の数 (tb の reg_sel の 0-88)
constexpr uint32_t kNoCause    = 0x7f;   // トラップでないクロックの原因の欄 (どの原因の番号とも重ならない)

rtlscope::Ring<kRingSize, kRingWords> g_ring;

std::unique_ptr<VerilatedContext> g_ctx;
std::unique_ptr<Vtop>             g_top;
std::deque<uint8_t>               g_in;
std::string                       g_out;
int                               g_sample_mode = 0;   // 0 毎クロック、1 事象のあるクロックだけ
uint64_t                          g_regs[kRegCount];   // sim_regs が返す写し
bool                              g_regs_frozen = false;   // g_regs が ring の止まった時の値
uint64_t                          g_fire_regs[kRegCount];  // トリガーが発火した時の写し
bool                              g_fire_valid = false;
uint32_t                          g_fire_head = 0;     // g_fire_regs を取った発火 (rtlscope の fire_head)
double                            g_regs_cycle = 0;    // g_regs を取った時のクロック数
uint32_t                          g_prev_slow[3] = {}; // 前のクロックの kSlowMask の信号 (語 0・9・13)
bool                              g_gap = true;   // 次に書くサンプルの前に途切れがある

inline uint32_t lo32(uint64_t v) { return static_cast<uint32_t>(v); }
inline uint32_t bit(bool b, int n) { return b ? 1u << n : 0u; }

// 1 クロックぶんの観測値を語に詰める (並びは頭のコメント)
void pack(uint32_t* w, bool tx, bool rx, uint8_t rx_ch) {
    const Vtop& t = *g_top;
    w[0] = bit(t.obs_retire, 0) | bit(t.obs_trap, 1) | bit(t.obs_trap_int, 2) |
           (static_cast<uint32_t>(t.obs_priv & 3) << 3) | bit(t.obs_itlb_miss, 5) | bit(t.obs_dtlb_miss, 6) |
           bit(t.obs_mem_rd, 7) | bit(t.obs_mem_wr, 8) | bit(t.obs_mem_rdata, 9) | bit(t.obs_mem_wdata, 10) |
           bit(tx, 11) | bit(rx, 12) | bit(t.obs_rd_we, 13) | bit(t.obs_trap_to_s, 14) | bit(t.obs_ireq, 15) |
           (static_cast<uint32_t>(t.obs_trap ? ((t.obs_trap_cause & 0x7f) | (t.obs_trap_int ? 0x80 : 0)) : kNoCause) << 16) |
           (static_cast<uint32_t>(tx ? t.uart_tx_data : (rx ? rx_ch : 0)) << 24);
    w[1]  = lo32(t.obs_pc);
    w[2]  = t.obs_insn;
    w[3]  = lo32(t.obs_mem_addr);
    w[4]  = lo32(t.obs_mem_data);
    w[5]  = lo32(t.obs_trap_tval);
    w[6]  = lo32(t.obs_rd_data);
    w[7]  = static_cast<uint32_t>(t.obs_rd_data >> 32);
    w[8]  = t.obs_events;
    w[9]  = (t.obs_rd & 31u) | (static_cast<uint32_t>(t.obs_irq & 15) << 5) | bit(t.obs_irq_pending, 9) |
            (static_cast<uint32_t>(t.obs_ie & 3) << 10) | bit(t.obs_dreq, 12) |
            (static_cast<uint32_t>(t.obs_dreq_cmd & 31) << 13) | (static_cast<uint32_t>(t.obs_dev) << 18) |
            (t.obs_rd2_we ? static_cast<uint32_t>(t.obs_rd2 & 31) << 27 : 0u);
    w[10] = lo32(t.obs_satp);
    w[11] = lo32(t.obs_trap_epc);
    w[12] = lo32(t.obs_dreq_addr);
    w[13] = (t.obs_mip & 0xffffu) | (static_cast<uint32_t>(t.obs_mie & 0xffffu) << 16);
    w[14] = lo32(t.cycle_count);
    w[15] = lo32(t.obs_rd2_data);
    w[16] = static_cast<uint32_t>(t.obs_rd2_data >> 32);
}

// 「事象のあるクロックだけ」でも書く物: 退役・トラップ・UART (語 0 の [1:0]・[12:11])、2 つ目の書き込み、
// そして前のクロックから変わった遅い信号 (TLB ミス・主記憶の受け渡し・割り込みの線と許可・SoC・mip/mie)。
// 1 クロックだけのパルス (SD の済み・claim など) も、変わった時に書くので落とさない
constexpr uint32_t kEventMask0   = 0x1803;
constexpr uint32_t kSlowMask0    = 0x07e0;       // 語 0 の [10:5]
constexpr uint32_t kSlowMask9    = 0x03fc0fe0;   // 語 9 の [11:5]・[25:18]
constexpr uint32_t kRd2Mask9     = 0xf8000000;   // 語 9 の [31:27]

bool worth_recording(const uint32_t* w) {
    const uint32_t slow[3] = {w[0] & kSlowMask0, w[9] & kSlowMask9, w[13]};
    const bool changed = slow[0] != g_prev_slow[0] || slow[1] != g_prev_slow[1] || slow[2] != g_prev_slow[2];
    for (int i = 0; i < 3; i++) g_prev_slow[i] = slow[i];
    return (w[0] & kEventMask0) || (w[9] & kRd2Mask9) || changed;
}

void record(bool rx, uint8_t rx_ch) {
    uint32_t w[kRingWords];
    pack(w, g_top->uart_tx_valid, rx, rx_ch);
    if (!worth_recording(w) && g_sample_mode == 1) return;
    if (g_gap) w[9] |= 1u << 26;
    g_ring.record(w);
    // 書けたか (止まっている時と LA OFF の時は書かない)。書けなければ、次に書くサンプルの前が途切れる
    const uint32_t* last = g_ring.data() + ((g_ring.head() - 1) & (kRingSize - 1)) * kRingWords;
    g_gap = g_ring.frozen() || last[14] != w[14] || last[9] != w[9];
}

// reg_sel を置いて eval し、reg_val を読む。clk は動かさないので、組み合わせの値が変わるだけ
void read_regs(uint64_t* dst) {
    for (int i = 0; i < kRegCount; i++) {
        g_top->reg_sel = static_cast<uint8_t>(i);
        g_top->eval();
        dst[i] = g_top->reg_val;
    }
    if (dst == g_regs) g_regs_cycle = static_cast<double>(g_top->cycle_count);
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
    // ring が止まったら、次に進める前に (止まった時の) レジスタを写す
    if (g_ring.frozen() != g_regs_frozen) {
        if (g_ring.frozen()) read_regs(g_regs);
        g_regs_frozen = g_ring.frozen();
    }
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
    // トリガーが発火したサンプルの直後に写す。再武装の直後にまた発火しても、fire_head が違うので取り直す
    if (g_ring.fired() && (!g_fire_valid || g_fire_head != static_cast<uint32_t>(g_ring.fire_head()))) {
        read_regs(g_fire_regs);
        g_fire_valid = true;
        g_fire_head  = static_cast<uint32_t>(g_ring.fire_head());
    }
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
EMSCRIPTEN_KEEPALIVE void        sim_set_sample_mode(int m) { g_sample_mode = (m == 1) ? 1 : 0; }

// 止まった ring なら止まった時の値。Hold の直後でまだ回していなければ、ここで写す
EMSCRIPTEN_KEEPALIVE const uint64_t* sim_regs() {
    if (g_ring.frozen() && !g_regs_frozen) {
        read_regs(g_regs);
        g_regs_frozen = true;
    } else if (!g_ring.frozen()) {
        read_regs(g_regs);
        g_regs_frozen = false;
    }
    return g_regs;
}
EMSCRIPTEN_KEEPALIVE int sim_regs_frozen() { return g_regs_frozen ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE const uint64_t* sim_regs_fire() {
    const bool same = g_fire_valid && g_ring.fired() && g_fire_head == static_cast<uint32_t>(g_ring.fire_head());
    return same ? g_fire_regs : nullptr;
}
EMSCRIPTEN_KEEPALIVE double sim_regs_cycle() { return g_regs_cycle; }
EMSCRIPTEN_KEEPALIVE int sim_reg_count() { return kRegCount; }

}  // extern "C"
