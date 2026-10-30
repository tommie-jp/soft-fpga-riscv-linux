// 元: soft-FPGA (https://github.com/tommie-jp/soft-fpga) の cxx/rtlscope_ring.h (soft-FPGA f59a45c、2026-10-17)。手を入れずに写した
// rtlscope_ring.h — Logic Analyzer 用 ring buffer（記録・Freeze・トリガー）
//
// 各 example のハーネスは「1 クロックぶんの観測値を word 配列に詰める」ことだけを書き、
// 記録・Freeze・エッジ/値トリガー・post delay・LA ON/OFF はこのヘッダに任せる。
// JS 側は js/rtlscope-la.js（RTLScopeLA）と js/sft-la-ctrl.js が対になる。
//
// 使い方（ハーネス側）:
//   #include "../../../cxx/rtlscope_ring.h"
//   static rtlscope::Ring<4096, 1> ring;
//   RTLSCOPE_EXPORT_RING(ring)          // 共通 API を extern "C" で公開する
//   ...step() の中で: uint32_t w[1] = { ... }; ring.record(w);
//
// ring のメモリ配置: サンプル i は buf[(i & (SIZE-1)) * WORDS + word]。
// head は書き込んだサンプルの総数（巻き戻さない）。

#pragma once

#include <stdint.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif
#ifndef EMSCRIPTEN_KEEPALIVE
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace rtlscope {

// トリガー種別の番号は 06-8080 のハーネスに合わせている。
enum TrigType { TRIG_OFF = 0, TRIG_EDGE = 4, TRIG_VALUE = 6 };

template <int SIZE, int WORDS>
class Ring {
    static_assert(SIZE > 0 && (SIZE & (SIZE - 1)) == 0, "SIZE は 2 のべき乗にすること");
    static_assert(WORDS >= 1, "WORDS は 1 以上にすること");

public:
    // ---- 参照 ----
    uint32_t* data()  { return buf_; }
    uint32_t  head() const { return head_; }
    int       size()  const { return SIZE; }
    int       words() const { return WORDS; }

    // ---- 記録 ----
    // 新しい観測セッションを始める（履歴と発火状態を捨てる）。
    // トリガー設定・post delay・LA ON/OFF は保持する。JS 側の UI 表示と食い違わないようにするため。
    void start_session() {
        head_ = 0;
        for (int i = 0; i < WORDS; i++) last_[i] = 0;
        rearm();
    }

    // 1 サンプル（WORDS 個の word）を記録し、トリガーを判定する。
    void record(const uint32_t* w) {
        for (int i = 0; i < WORDS; i++) last_[i] = w[i];

        if (!frozen_) {
            if (la_enabled_) {
                uint32_t* dst = &buf_[(head_ & (SIZE - 1)) * WORDS];
                for (int i = 0; i < WORDS; i++) dst[i] = w[i];
            }
            head_++;
        }

        if (!fired_ && !frozen_) evaluate_trigger(w);

        // ポストトリガー: 発火後 post_delay_ クロック記録したら Freeze
        if (fired_ && !hit_ && head_ - fire_head_ >= post_delay_) {
            hit_    = true;
            frozen_ = true;
        }
    }

    // ---- Freeze ----
    void freeze() { frozen_ = true; }
    // Thaw はトリガーも再武装する（発火済みのまま残すと直後に再 Freeze されるため）。
    void thaw()   { rearm(); }
    bool frozen() const { return frozen_; }

    // LA OFF の間は buf_ に書かない（head は進む）。ON に戻すとき、OFF 区間に残った古い
    // サンプルが本物の波形として見えないよう、buf_ を 0 で埋め直す。
    void set_la(bool on) {
        if (on && !la_enabled_) {
            for (int i = 0; i < SIZE * WORDS; i++) buf_[i] = 0;
        }
        la_enabled_ = on;
    }
    void set_post_delay(int n) { post_delay_ = (n > 0) ? (uint32_t)n : 0; }

    // ---- トリガー ----
    void clear_trigger() { trig_type_ = TRIG_OFF; rearm(); }

    // word: word 番号, bit: ビット番号, dir: 0=立ち上がり 1=立ち下がり
    void set_edge_trigger(int word, int bit, int dir) {
        trig_type_  = TRIG_EDGE;
        edge_word_  = clamp_word(word);
        edge_bit_   = bit & 31;
        edge_dir_   = dir ? 1 : 0;
        rearm();
    }

    // (w[word] & mask) == (cmp & mask) になった瞬間に発火する。
    // 一致し続けている間は再発火しない（Thaw 直後に再 Freeze されるのを防ぐ）。
    void set_value_trigger(int word, uint32_t mask, uint32_t cmp) {
        trig_type_  = TRIG_VALUE;
        val_word_   = clamp_word(word);
        val_mask_   = mask;
        val_cmp_    = cmp & mask;
        rearm();
    }

    bool hit()   const { return hit_; }     // Freeze 完了
    bool fired() const { return fired_; }   // 発火済み
    // 発火時点の head（未発火は -1）。JS 側で赤い縦線の位置になる。
    int  fire_head() const { return fired_ ? (int)fire_head_ : -1; }

private:
    static int clamp_word(int w) { return (w < 0 || w >= WORDS) ? 0 : w; }
    static uint32_t bit_of(uint32_t v, int bit) { return (v >> bit) & 1u; }

    // 発火・Freeze 状態を解除して、直近サンプルを基準にエッジ検出を再開する。
    void rearm() {
        fired_      = false;
        hit_        = false;
        fire_head_  = 0;
        frozen_     = false;
        prev_edge_  = bit_of(last_[clamp_word(edge_word_)], edge_bit_);
        prev_match_ = value_matches(last_);
    }

    bool value_matches(const uint32_t* w) const {
        return (w[val_word_] & val_mask_) == val_cmp_;
    }

    void evaluate_trigger(const uint32_t* w) {
        if (trig_type_ == TRIG_EDGE) {
            const uint32_t cur = bit_of(w[edge_word_], edge_bit_);
            const bool hit = edge_dir_ ? (prev_edge_ && !cur) : (!prev_edge_ && cur);
            prev_edge_ = cur;
            if (hit) { fired_ = true; fire_head_ = head_; }
        } else if (trig_type_ == TRIG_VALUE) {
            const bool match = value_matches(w);
            if (match && !prev_match_) { fired_ = true; fire_head_ = head_; }
            prev_match_ = match;
        }
    }

    uint32_t buf_[SIZE * WORDS] = {};
    uint32_t last_[WORDS]       = {};
    uint32_t head_              = 0;

    bool     la_enabled_ = true;
    bool     frozen_     = false;

    int      trig_type_  = TRIG_OFF;
    int      edge_word_  = 0;
    int      edge_bit_   = 0;
    int      edge_dir_   = 0;
    uint32_t prev_edge_  = 0;
    int      val_word_   = 0;
    uint32_t val_mask_   = 0;
    uint32_t val_cmp_    = 0;
    bool     prev_match_ = false;
    uint32_t post_delay_ = 0;
    bool     fired_      = false;
    bool     hit_        = false;
    uint32_t fire_head_  = 0;
};

} // namespace rtlscope

// 共通の Wasm エクスポート。RING には rtlscope::Ring のインスタンスを渡す。
// ファイルスコープで 1 回だけ使う。
#define RTLSCOPE_EXPORT_RING(RING)                                                      \
    extern "C" {                                                                        \
    EMSCRIPTEN_KEEPALIVE uint32_t* get_ring_ptr()   { return (RING).data(); }           \
    EMSCRIPTEN_KEEPALIVE uint32_t  get_head()       { return (RING).head(); }           \
    EMSCRIPTEN_KEEPALIVE int       get_ring_size()  { return (RING).size(); }           \
    EMSCRIPTEN_KEEPALIVE int       get_ring_words() { return (RING).words(); }          \
    EMSCRIPTEN_KEEPALIVE void sim_freeze_ring()     { (RING).freeze(); }                \
    EMSCRIPTEN_KEEPALIVE void sim_thaw_ring()       { (RING).thaw(); }                  \
    EMSCRIPTEN_KEEPALIVE int  sim_ring_frozen()     { return (RING).frozen() ? 1 : 0; } \
    EMSCRIPTEN_KEEPALIVE void sim_set_la(int on)    { (RING).set_la(on != 0); }         \
    EMSCRIPTEN_KEEPALIVE void sim_set_post_delay(int n) { (RING).set_post_delay(n); }   \
    EMSCRIPTEN_KEEPALIVE void sim_clear_trigger()   { (RING).clear_trigger(); }         \
    EMSCRIPTEN_KEEPALIVE void sim_set_edge_trigger(int word, int bit, int dir)          \
        { (RING).set_edge_trigger(word, bit, dir); }                                    \
    EMSCRIPTEN_KEEPALIVE void sim_set_value_trigger(int word, int mask, int cmp)        \
        { (RING).set_value_trigger(word, (uint32_t)mask, (uint32_t)cmp); }              \
    EMSCRIPTEN_KEEPALIVE int  sim_trigger_hit()     { return (RING).hit() ? 1 : 0; }    \
    EMSCRIPTEN_KEEPALIVE int  sim_trigger_fired()   { return (RING).fired() ? 1 : 0; }  \
    EMSCRIPTEN_KEEPALIVE int  sim_get_trig_fire_head() { return (RING).fire_head(); }   \
    }
