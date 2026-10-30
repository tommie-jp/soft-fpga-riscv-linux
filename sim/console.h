// console.h : 標準入力から UART の受信へ渡す字を溜める
//
// 端末なら raw にし (打った字をそのまま、エコーは Linux がする)、終わる時に戻す。
// パイプやファイルなら、その中身を行ごとに渡す (main.cpp がプロンプトを待って渡す)。
#pragma once

#include <cstdint>
#include <deque>

class Console {
public:
    static constexpr uint8_t kQuitKey = 0x1d;   // Ctrl-] : 対話を終える (telnet と同じ)

    // 標準入力を調べ、端末なら raw にする。失敗したら理由を stderr に書いて false
    bool open();
    // 端末を元に戻す (何度呼んでもよい)
    void close();

    // 読めるだけ読んで溜める (待たない)
    void poll();

    bool is_tty() const { return is_tty_; }
    bool eof() const { return eof_; }
    bool quit() const { return quit_; }
    std::deque<uint8_t>& pending() { return pending_; }

private:
    bool                is_tty_ = false;
    bool                eof_    = false;
    bool                quit_   = false;
    std::deque<uint8_t> pending_;
};
