// plusarg.h : "+name=value" の value を読む (main.cpp と load.cpp で使う)
#pragma once

#include <string>

#include "verilated.h"

// 無ければ空
inline std::string plusarg(VerilatedContext& ctx, const char* name) {
    const std::string prefix = std::string(name) + "=";
    const std::string match  = ctx.commandArgsPlusMatch(prefix.c_str());
    return match.empty() ? std::string() : match.substr(prefix.size() + 1);
}
