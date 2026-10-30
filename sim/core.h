// core.h : sim/main.cpp とコアごとの cores/<名前>/load.cpp の境目
//
// 模型のクラスはどのコアでも Vtop (verilator --prefix Vtop)。main.cpp はポートだけを触り、
// 階層名 (rootp->..._DOT_...) は load.cpp にだけ書く。
#pragma once

#include "Vtop.h"
#include "verilated.h"

// 最初の eval (initial が走った後) に呼ぶ。主記憶などを書く。
// 足りない plusarg や読めないファイルがあれば、理由を stderr に書いて false を返す
bool core_load(VerilatedContext& ctx, Vtop& top);

// core_load が読む plusarg の使い方 (1 行)
extern const char* const kCoreUsage;
