'use strict';
// la-defs.js — mmRISC-2 の Logic Analyzer (rtlscope) の信号定義
//
// ring の並び (sim/wasm/harness.cpp の record と合わせる。1 クロックに 6 語):
//   語 0: [0] 退役 [1] トラップ [2] 割り込み [4:3] 特権 [5] ITLB ミス [6] DTLB ミス
//         [7] 主記憶の読み [8] 書き [9] 読みデータ [10] 書きデータ [11] UART 送信 [12] UART 受信
//         [23:16] トラップの原因 [31:24] UART の字
//   語 1: PC の下 32 ビット   語 2: 命令   語 3: 主記憶の番地の下 32 ビット
//   語 4: 主記憶のデータの下 32 ビット   語 5: tval の下 32 ビット

var MMRISC2_LA_SIGNALS = [
  // CPU
  { id: 'retire', label: 'Retire', word: 0, bit: 0, type: 'bit', width: 1, color: '#2868b0', on: true,
    tip: '命令が 1 つ退役した' },
  { id: 'pc', label: 'PC', word: 1, bit: 0, type: 'hex', width: 32, color: '#2868b0', on: true, fmt: 'hex32',
    tip: '退役した命令の PC (下 32 ビット)。カーネルは 0x8xxxxxxx、ユーザーは小さい番地' },
  { id: 'insn', label: 'Insn', word: 2, bit: 0, type: 'hex', width: 32, color: '#3a7ac0', on: true, fmt: 'hex32',
    tip: '退役した命令' },
  { id: 'priv', label: 'Priv', word: 0, bit: 3, type: 'hex', width: 2, color: '#8020c0', on: true, fmt: 'priv',
    tip: '退役した命令の特権モード (U / S / M)' },
  // トラップ
  { id: 'trap', label: 'Trap', word: 0, bit: 1, type: 'bit', width: 1, color: '#c04010', on: true,
    tip: 'トラップに入った (例外か割り込み)' },
  { id: 'trap_int', label: 'Int', word: 0, bit: 2, type: 'bit', width: 1, color: '#c04010', on: false,
    tip: 'そのトラップが割り込みなら 1' },
  { id: 'cause', label: 'Cause', word: 0, bit: 16, type: 'dec', width: 8, color: '#c04010', on: true,
    tip: 'トラップの原因の番号 (8 = U モードの ecall、13 / 15 = ページフォールト ...)' },
  { id: 'tval', label: 'Tval', word: 5, bit: 0, type: 'hex', width: 32, color: '#c04010', on: false, fmt: 'hex32',
    tip: 'tval (フォールトした番地など、下 32 ビット)' },
  // MMU
  { id: 'itlb', label: 'ITLB', word: 0, bit: 5, type: 'bit', width: 1, color: '#9020a0', on: true,
    tip: '命令側の TLB を引き損ね、ページ表を引いている間 1' },
  { id: 'dtlb', label: 'DTLB', word: 0, bit: 6, type: 'bit', width: 1, color: '#9020a0', on: true,
    tip: 'データ側の TLB を引き損ね、ページ表を引いている間 1' },
  // 主記憶 (AXI4)
  { id: 'mem_rd', label: 'MemRd', word: 0, bit: 7, type: 'bit', width: 1, color: '#a07020', on: true,
    tip: '主記憶へ読みを出した (L2 の外。AR の受け渡し)' },
  { id: 'mem_wr', label: 'MemWr', word: 0, bit: 8, type: 'bit', width: 1, color: '#a07020', on: true,
    tip: '主記憶へ書きを出した (AW の受け渡し)' },
  { id: 'addr', label: 'Addr', word: 3, bit: 0, type: 'hex', width: 32, color: '#a07020', on: true, fmt: 'hex32',
    tip: '主記憶の番地 (物理、下 32 ビット)' },
  { id: 'rdata', label: 'RData', word: 0, bit: 9, type: 'bit', width: 1, color: '#0a7858', on: false,
    tip: '読んだデータが 1 拍来た (R の受け渡し)' },
  { id: 'wdata', label: 'WData', word: 0, bit: 10, type: 'bit', width: 1, color: '#0a7858', on: false,
    tip: '書くデータを 1 拍出した (W の受け渡し)' },
  { id: 'data', label: 'Data', word: 4, bit: 0, type: 'hex', width: 32, color: '#0a7858', on: false, fmt: 'hex32',
    tip: 'その拍のデータ (下 32 ビット)' },
  // UART
  { id: 'uart_rx', label: 'RX', word: 0, bit: 12, type: 'bit', width: 1, color: '#c08000', on: true,
    tip: '打った字が UART の受信 FIFO に入った' },
  { id: 'uart_tx', label: 'TX', word: 0, bit: 11, type: 'bit', width: 1, color: '#c08000', on: true,
    tip: 'UART が 1 字送った' },
  { id: 'uart_ch', label: 'Char', word: 0, bit: 24, type: 'hex', width: 8, color: '#c08000', on: true, fmt: 'char',
    tip: 'UART の字 (送信か受信)' }
];

function fmtCharMmrisc2(v) {
  var c = v & 0xff;
  if (c === 0x0d) return '\\r';
  if (c === 0x0a) return '\\n';
  if (c === 0x1b) return 'ESC';
  return (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : c.toString(16).padStart(2, '0');
}

var MMRISC2_LA_CONFIG = {
  signals:       MMRISC2_LA_SIGNALS,
  width:         928,
  labelWidth:    60,
  trackH:        22,
  storagePrefix: 'mmrisc2_la_',
  groups: [
    { label: 'CPU',    color: '#2868b0', ids: ['retire', 'pc', 'insn', 'priv'] },
    { label: 'Trap',   color: '#c04010', ids: ['trap', 'trap_int', 'cause', 'tval'] },
    { label: 'MMU',    color: '#9020a0', ids: ['itlb', 'dtlb'] },
    { label: 'Memory', color: '#a07020', ids: ['mem_rd', 'mem_wr', 'addr', 'rdata', 'wdata', 'data'] },
    { label: 'UART',   color: '#c08000', ids: ['uart_rx', 'uart_tx', 'uart_ch'] }
  ],
  formatters: {
    // 既定の 16 進は 0x80000000 以上を負の数で出すので、符号なしで 8 桁にする
    hex32: function (v) { return (v >>> 0).toString(16).toUpperCase().padStart(8, '0'); },
    priv: function (v) { return ['U', 'S', '?', 'M'][v & 3]; },
    char: function (v) { return fmtCharMmrisc2(v); }
  }
};

// トリガーのプリセット (sft-la-ctrl.js の triggerPresets)。post は発火後に記録するクロック数
var MMRISC2_TRIGGER_PRESETS = [
  { label: '打鍵 / Key press', tip: '打った字が UART に入った瞬間から。割り込み → カーネル → ash が動く / From the moment a typed key reaches the UART: interrupt, kernel, ash', sig: 'uart_rx', mode: 'rise', post: 6000 },
  { label: 'U モード / U-mode', tip: 'ユーザーのプログラム (ash や ls) の命令が退役し始めた所 / Where instructions of a user program (ash, ls) start to retire', sig: 'priv', mode: 'eq', value: '0', post: 4000 },
  { label: 'トラップ / Trap', tip: '例外か割り込みでトラップに入った所 / Entry to a trap, by an exception or an interrupt', sig: 'trap', mode: 'rise', post: 2000 },
  { label: 'DTLB ミス / DTLB miss', tip: 'データ側の TLB を引き損ねてページ表を引き始める所 / A data-side TLB miss, where the page table walk starts', sig: 'dtlb', mode: 'rise', post: 2000 }
];
