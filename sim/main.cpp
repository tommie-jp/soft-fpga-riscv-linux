// main.cpp : 模型の時計・リセット・止める条件・UART と標準入出力 (どのコアでも共通)
//
// 元の tb_BIOS.sv が --timing (always #5、@(posedge clk)) でしていた事をここで回す。
// --timing を外せば --savable と一緒に作れる。
// 模型とはポートだけでつながる (core.h)。主記憶への読み込みはコアごとの load.cpp。
//
// UART (第 2 段): uart_tx_* の字を標準出力へ。標準入力の字を uart_rx_* へ。
//   - 入力が無い (/dev/null) : 最初のプロンプトで止まる (第 1 段と同じ)
//   - パイプかファイル       : プロンプトが出るたびに 1 行渡し、全部渡した後のプロンプトで止まる
//   - 端末                   : 打った字をそのまま渡す。Ctrl-] で止まる
//   どれも、最初のプロンプトまでは字を渡さない (起動中のカーネルに読ませない)
//
// 保存と読み戻し (第 3 段、--savable):
//   +save=<file>     最初のプロンプトが出た所 (まだ字を渡す前) で模型を保存し、そのまま続ける
//   +restore=<file>  保存した所から始める。+fw などの読み込みとリセットはしない
#include <sys/stat.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <memory>
#include <string>

#include "console.h"
#include "core.h"
#include "plusarg.h"
#include "verilated_save.h"

namespace {

constexpr int      kResetCycles = 20;      // 元: repeat (20) @(posedge clk)
constexpr int      kTailCycles  = 20000;   // 元: 止める条件の後の repeat (20000)。行の残りを出す
constexpr uint64_t kHalfPeriod  = 5;       // 元: always #5 (timescale 1ns)
constexpr int      kPollCycles  = 4096;    // 標準入力を見る間隔 (PC で 1 秒に約 100 回)
constexpr uint64_t kMaxCyclesDefault = 3000000;   // +maxcycles が無い時 (元の tb_BIOS.sv と同じ)

// tb の STOP_* と同じ値
constexpr int kStopNone   = 0;
constexpr int kStopPrompt = 1;

void tick(VerilatedContext& ctx, Vtop& top) {
    top.clk = 1;
    top.eval();
    ctx.timeInc(kHalfPeriod);
    top.clk = 0;
    top.eval();
    ctx.timeInc(kHalfPeriod);
}

double seconds_since(std::chrono::steady_clock::time_point t0) {
    return std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
}

long long file_bytes(const std::string& path) {
    struct stat st;
    return (stat(path.c_str(), &st) == 0) ? static_cast<long long>(st.st_size) : -1;
}

// 時刻 (VerilatedContext) と模型を書く。書けなければ false
bool save_state(const std::string& path, VerilatedContext& ctx, Vtop& top) {
    const auto    t0 = std::chrono::steady_clock::now();
    VerilatedSave os;
    os.open(path);
    if (!os.isOpen()) {
        std::fprintf(stderr, "main: cannot write %s\n", path.c_str());
        return false;
    }
    os << &ctx;
    os << top;
    os.close();
    std::printf("\nmain: saved %s, %lld bytes, cycle %llu, in %.1f s\n", path.c_str(), file_bytes(path),
                static_cast<unsigned long long>(top.cycle_count), seconds_since(t0));
    std::fflush(stdout);
    return true;
}

bool restore_state(const std::string& path, VerilatedContext& ctx, Vtop& top) {
    const auto       t0 = std::chrono::steady_clock::now();
    VerilatedRestore is;
    is.open(path);
    if (!is.isOpen()) {
        std::fprintf(stderr, "main: cannot read %s\n", path.c_str());
        return false;
    }
    is >> &ctx;
    is >> top;
    is.close();
    std::printf("main: restored %s, %lld bytes, cycle %llu, in %.1f s\n", path.c_str(), file_bytes(path),
                static_cast<unsigned long long>(top.cycle_count), seconds_since(t0));
    std::fflush(stdout);
    return true;
}

// 標準入力の字を、プロンプトに合わせて UART の受信へ渡す
class Feeder {
public:
    // on_first_prompt: 最初のプロンプトを見た時 (字を渡す前) に 1 度呼ぶ。false なら止める
    Feeder(Console& con, std::function<bool()> on_first_prompt)
        : con_(con), on_first_prompt_(std::move(on_first_prompt)) {}

    // 1 クロック回す。止める時なら true
    bool step(VerilatedContext& ctx, Vtop& top) {
        if ((cycle_++ % kPollCycles) == 0) con_.poll();
        const int  stop      = top.stop_code;
        const bool at_prompt = (stop == kStopPrompt);
        if (stop != kStopNone && !at_prompt) return true;   // panic・root 待ち・上限
        if (con_.quit()) return true;
        if (at_prompt && !prompt_seen_) {
            prompt_seen_ = true;
            if (on_first_prompt_ && !on_first_prompt_()) return true;
        }
        if (stop == kStopNone) left_prompt_ = true;

        // 渡した行のエコーでプロンプトが一度消え、また出た (または何も渡していない)。
        // stop_code は字が出てから 2 クロック遅れるので、「字が出た」では決めない
        const bool ready_for_line = at_prompt && (!sent_any_ || left_prompt_);
        if (!con_.is_tty() && ready_for_line && !in_line_) {
            if (con_.pending().empty() && con_.eof()) return true;
            if (!con_.pending().empty()) in_line_ = true;
        }
        const bool may_send = con_.is_tty() ? prompt_seen_ : in_line_;
        const bool sending  = may_send && !con_.pending().empty() && top.uart_rx_ready;
        const uint8_t ch    = sending ? con_.pending().front() : 0;
        top.uart_rx_valid   = sending;
        top.uart_rx_data    = ch;

        tick(ctx, top);

        if (sending) {
            con_.pending().pop_front();
            sent_any_    = true;
            left_prompt_ = false;
            if (ch == '\n') in_line_ = false;
        }
        top.uart_rx_valid = 0;
        if (top.uart_tx_valid) {   // 次の立ち上がりで出る字
            std::putchar(top.uart_tx_data);
            std::fflush(stdout);
        }
        return ctx.gotFinish();
    }

private:
    Console&              con_;
    std::function<bool()> on_first_prompt_;
    uint64_t              cycle_       = 0;
    bool     prompt_seen_ = false;
    bool     sent_any_    = false;
    bool     left_prompt_ = false;   // 最後に渡した字の後に、プロンプトでない時があった
    bool     in_line_     = false;   // 1 行を渡している途中
};

}  // namespace

int main(int argc, char** argv) {
    auto ctx = std::make_unique<VerilatedContext>();
    ctx->commandArgs(argc, argv);
    auto top = std::make_unique<Vtop>(ctx.get());

    // 最初の eval で initial が走る。その後で主記憶を書く (元の #1 の後と同じ順)
    top->clk           = 0;
    top->rst_n         = 0;
    top->uart_rx_valid = 0;
    top->uart_rx_data  = 0;
    top->eval();

    // 読み戻す時も最初の eval は済ませておき、その上に書く (initial をもう走らせない)
    const std::string save_path    = plusarg(*ctx, "save");
    const std::string restore_path = plusarg(*ctx, "restore");
    if (!restore_path.empty()) {
        if (!restore_state(restore_path, *ctx, *top)) return 1;
    } else if (!core_load(*ctx, *top)) {
        std::fprintf(stderr, "usage: %s %s [+maxcycles=<n>] [+save=<file>] ...\n", argv[0], kCoreUsage);
        std::fprintf(stderr, "       %s +restore=<file> [+maxcycles=<n>] ...\n", argv[0]);
        return 1;
    }
    std::fflush(stdout);

    // 上限は読み戻した後にも渡す (模型の中に持たせると保存した時の値に戻る)
    const std::string max_arg = plusarg(*ctx, "maxcycles");
    char*             max_end = nullptr;
    top->max_cycles = max_arg.empty() ? kMaxCyclesDefault : std::strtoull(max_arg.c_str(), &max_end, 10);
    if (!max_arg.empty() && *max_end != '\0') {
        std::fprintf(stderr, "main: +maxcycles=%s is not a number\n", max_arg.c_str());
        return 1;
    }

    Console con;
    if (!con.open()) return 1;
    Feeder feeder(con, [&]() { return save_path.empty() || save_state(save_path, *ctx, *top); });

    const auto     t0 = std::chrono::steady_clock::now();
    const uint64_t c0 = top->cycle_count;   // 読み戻した時は保存した時のクロック

    if (restore_path.empty()) {
        for (int i = 0; i < kResetCycles && !ctx->gotFinish(); i++) tick(*ctx, *top);
    }
    top->rst_n = 1;

    while (!feeder.step(*ctx, *top)) {
    }
    // 行の残りを出す。もう字は渡さない
    for (int i = 0; i < kTailCycles && !ctx->gotFinish(); i++) {
        tick(*ctx, *top);
        if (top->uart_tx_valid) std::putchar(top->uart_tx_data);
    }
    std::fflush(stdout);
    con.close();

    const double   secs   = seconds_since(t0);
    const uint64_t cycles = top->cycle_count;
    top->final();
    std::printf(" stop_code=%d, cycle %llu, %llu cycles in %.1f s, %.0f cycles/s\n",
                static_cast<int>(top->stop_code), static_cast<unsigned long long>(cycles),
                static_cast<unsigned long long>(cycles - c0), secs, static_cast<double>(cycles - c0) / secs);
    return 0;
}
