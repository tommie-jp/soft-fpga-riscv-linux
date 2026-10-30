// console.cpp : console.h の中身
#include "console.h"

#include <poll.h>
#include <termios.h>
#include <unistd.h>

#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

struct termios g_saved;
bool           g_raw = false;

void restore_tty() {
    if (g_raw) {
        tcsetattr(STDIN_FILENO, TCSANOW, &g_saved);
        g_raw = false;
    }
}

// ESC [ 数字 ; 数字 R (端末がカーソル位置を答えた物) なら、その長さ。違えば 0
size_t cursor_report_len(const uint8_t* p, size_t n) {
    if (n < 6 || p[0] != 0x1b || p[1] != '[') return 0;
    size_t i      = 2;
    int    fields = 0;
    while (i < n) {
        const size_t start = i;
        while (i < n && p[i] >= '0' && p[i] <= '9') i++;
        if (i == start || i == n) return 0;
        fields++;
        if (p[i] == 'R') return (fields == 2) ? i + 1 : 0;
        if (p[i] != ';' || fields == 2) return 0;
        i++;
    }
    return 0;
}

// kill などで終わっても端末を raw のまま残さない
void on_signal(int sig) {
    if (g_raw) tcsetattr(STDIN_FILENO, TCSANOW, &g_saved);
    std::_Exit(128 + sig);
}

}  // namespace

bool Console::open() {
    is_tty_ = isatty(STDIN_FILENO);
    if (!is_tty_) return true;

    if (tcgetattr(STDIN_FILENO, &g_saved) != 0) {
        std::fprintf(stderr, "console: tcgetattr: %s\n", std::strerror(errno));
        return false;
    }
    struct termios raw = g_saved;
    // 1 字ずつ、エコー無し、Ctrl-C も Ctrl-S も Linux へ渡す。出力 (OPOST) はそのまま
    raw.c_lflag &= ~(ICANON | ECHO | ISIG | IEXTEN);
    raw.c_iflag &= ~(IXON | ICRNL);
    raw.c_cc[VMIN]  = 0;
    raw.c_cc[VTIME] = 0;
    if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) != 0) {
        std::fprintf(stderr, "console: tcsetattr: %s\n", std::strerror(errno));
        return false;
    }
    g_raw = true;
    std::atexit(restore_tty);
    std::signal(SIGTERM, on_signal);
    std::signal(SIGHUP, on_signal);
    std::fprintf(stderr, "console: interactive, Ctrl-] to quit\r\n");
    return true;
}

void Console::close() { restore_tty(); }

void Console::poll() {
    if (eof_ || quit_) return;
    struct pollfd pfd = {STDIN_FILENO, POLLIN, 0};
    while (::poll(&pfd, 1, 0) > 0) {
        uint8_t       buf[256];
        const ssize_t n = read(STDIN_FILENO, buf, sizeof buf);
        if (n <= 0) {   // 0 は終わり。端末では raw なので Ctrl-D も 1 字として来る
            if (n < 0) std::fprintf(stderr, "console: read: %s\n", std::strerror(errno));
            eof_ = true;
            return;
        }
        for (ssize_t i = 0; i < n; i++) {
            if (is_tty_ && buf[i] == kQuitKey) {
                quit_ = true;
                return;
            }
            // ash はプロンプトのたびにカーソル位置を問い (ESC[6n)、端末が答える。答えを渡すと、
            // その後の模型の時間で約 50 ミリ秒 (PC で 6 秒ほど) 打った字が捨てられるので渡さない
            const size_t skip = is_tty_ ? cursor_report_len(buf + i, static_cast<size_t>(n - i)) : 0;
            if (skip > 0) {
                i += static_cast<ssize_t>(skip) - 1;
                continue;
            }
            pending_.push_back(buf[i]);
        }
    }
}
