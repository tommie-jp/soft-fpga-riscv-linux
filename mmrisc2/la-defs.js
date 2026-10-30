'use strict';
// la-defs.js — mmRISC-2 の Logic Analyzer (rtlscope) の信号定義
//
// ring の並び (sim/wasm/harness.cpp の pack と合わせる。1 サンプルに 17 語):
//   語 0: [0] 退役 [1] トラップ [2] 割り込み [4:3] 特権 [5] ITLB ミス [6] DTLB ミス
//         [7] 主記憶の読み [8] 書き [9] 読みデータ [10] 書きデータ [11] UART 送信 [12] UART 受信
//         [13] rd に書いた [14] トラップが S へ [15] I$ への読み
//         [22:16] トラップの原因 [23] 割り込みなら 1 (トラップでないクロックは 0x7f) [31:24] UART の字
//   語 1: PC   語 2: 命令   語 3: 主記憶の番地   語 4: 主記憶のデータ   語 5: tval   (どれも下 32 ビット)
//   語 6・7: rd に書いた値の下・上 32 ビット   語 8: 性能の事象 (mmRISC-2 の hpm_ev)
//   語 9: [4:0] rd [8:5] 割り込みの線 [9] 割り込みが待っている [10] SIE [11] MIE [12] D$ への読み書き
//         [17:13] その種類 [20:18] SD の状態 [21] SD コマンド済み [22] SD データ済み [23] PLIC の割り込み
//         [24] PLIC の claim [25] DMA が動いている [26] 途切れの後の最初のサンプル [31:27] 2 つ目の書き込みのレジスタ
//   語 10: satp   語 11: epc   語 12: D$ への番地 (仮想)   (どれも下 32 ビット)
//   語 13: [15:0] mip [31:16] mie   語 14: クロック数の下 32 ビット   語 15・16: 2 つ目の書き込みの値
//
// tip は { ja, en }。ページが組み立てる時に mmrisc2LaSignals(lang) で文字にする (rtlscope の信号のチップは
// tip をそのまま title にするので、{ ja, en } のままだと [object Object] と出る)。命令の読み方は rv-disasm.js (RVDIS)。

// 信号を短く書く: s(id, label, word, bit, width, color, on, ja, en, fmt)
function mmrisc2Sig(id, label, word, bit, width, color, on, ja, en, fmt) {
  var sig = { id: id, label: label, word: word, bit: bit, width: width, color: color, on: on,
              type: width === 1 ? 'bit' : 'hex', tip: { ja: ja, en: en } };
  if (fmt) sig.fmt = fmt;
  return sig;
}

var MMRISC2_COLORS = {
  cpu: '#2868b0', reg: '#1f7a8c', trap: '#c04010', irq: '#d0408a', mmu: '#9020a0',
  l1: '#5a6e20', pipe: '#6a5acd', mem: '#a07020', soc: '#7a5230', uart: '#c08000', clk: '#555555'
};

var MMRISC2_LA_SIGNALS = (function () {
  var C = MMRISC2_COLORS, S = mmrisc2Sig;
  return [
    // CPU
    S('retire', 'Retire', 0, 0, 1, C.cpu, true, '命令が 1 つ退役した', 'An instruction retired'),
    S('pc', 'PC', 1, 0, 32, C.cpu, true, '退役した命令の PC (下 32 ビット)。カーネルは FFxxxxxx か 8xxxxxxx、ユーザーは小さい番地',
      'PC of the retired instruction (low 32 bits). The kernel is at FFxxxxxx or 8xxxxxxx, user programs low', 'hex32'),
    S('insn', 'Insn', 2, 0, 32, C.cpu, true, '退役した命令 (読んだ形。値の欄は命令の名前)',
      'The retired instruction, disassembled (the value column shows the mnemonic)', 'insn'),
    S('insn_hex', 'InsnHex', 2, 0, 32, C.cpu, false, '退役した命令の符号 (16 進。圧縮命令は下 16 ビット)',
      'The encoding of the retired instruction (hex; a compressed one is the low 16 bits)', 'hex32'),
    S('priv', 'Priv', 0, 3, 2, C.cpu, true, '退役した命令の特権モード (U / S / M)', 'Privilege of the retired instruction (U / S / M)', 'priv'),
    // 書き戻し
    S('rd_we', 'RdWe', 0, 13, 1, C.reg, true, '退役した命令が整数レジスタに書いた', 'The retired instruction wrote an integer register'),
    S('rd', 'Rd', 9, 0, 5, C.reg, true, '書いたレジスタ (ABI 名)', 'The register written (ABI name)', 'abi'),
    S('rd_data', 'RdData', 6, 0, 32, C.reg, true, '書いた値 (下 32 ビット)', 'The value written (low 32 bits)', 'hex32'),
    S('rd_data_hi', 'RdHi', 7, 0, 32, C.reg, false, '書いた値 (上 32 ビット)', 'The value written (high 32 bits)', 'hex32'),
    S('rd2', 'Rd2', 9, 27, 5, C.reg, false, '退役とは別に整数レジスタへ書いた所 (FPU の答えが整数の時。feq・fcvt.l.d など)。zero なら書いていない',
      'A second integer register write, apart from retire (FPU results to an integer register: feq, fcvt.l.d ...). zero means none', 'abi'),
    S('rd2_data', 'Rd2Data', 15, 0, 32, C.reg, false, 'その値 (下 32 ビット)', 'Its value (low 32 bits)', 'hex32'),
    // トラップ
    S('trap', 'Trap', 0, 1, 1, C.trap, true, 'トラップに入った (例外か割り込み)', 'Entered a trap (exception or interrupt)'),
    S('trap_int', 'Int', 0, 2, 1, C.trap, false, 'そのトラップが割り込みなら 1', '1 if the trap is an interrupt'),
    S('cause', 'Cause', 0, 16, 8, C.trap, true, 'トラップの原因 (ecall U・ページフォールト・S タイマー ...)。トラップでない所は -',
      'Trap cause (ecall from U, page fault, S timer ...); - when there is no trap', 'cause'),
    S('trap_to_s', 'ToS', 0, 14, 1, C.trap, false, 'トラップが S モード (カーネル) へ行く。0 なら M モード (OpenSBI)',
      'The trap goes to S mode (the kernel); 0 means M mode (OpenSBI)'),
    S('epc', 'EPC', 11, 0, 32, C.trap, false, 'トラップした命令の PC (下 32 ビット)', 'PC of the trapping instruction (low 32 bits)', 'hex32'),
    S('tval', 'Tval', 5, 0, 32, C.trap, false, 'tval (フォールトした番地など、下 32 ビット)', 'tval (the faulting address and so on, low 32 bits)', 'hex32'),
    // 割り込み
    S('irq_mtimer', 'MTimer', 9, 6, 1, C.irq, false, 'CLINT から M タイマー割り込みの線', 'M timer interrupt line from the CLINT'),
    S('irq_mext', 'MExt', 9, 7, 1, C.irq, false, 'PLIC から M 外部割り込みの線', 'M external interrupt line from the PLIC'),
    S('irq_sext', 'SExt', 9, 8, 1, C.irq, true, 'PLIC から S 外部割り込みの線 (UART・SD はここ)', 'S external interrupt line from the PLIC (UART and SD come here)'),
    S('irq_msoft', 'MSoft', 9, 5, 1, C.irq, false, 'CLINT から M ソフトウェア割り込みの線', 'M software interrupt line from the CLINT'),
    S('stip', 'STIP', 13, 5, 1, C.irq, true, 'mip.STIP: S タイマー割り込みが待っている (Sstc の stimecmp。HZ=100 の刻み)',
      'mip.STIP: an S timer interrupt is pending (stimecmp of Sstc; the HZ=100 tick)'),
    S('seip', 'SEIP', 13, 9, 1, C.irq, false, 'mip.SEIP: S 外部割り込みが待っている', 'mip.SEIP: an S external interrupt is pending'),
    S('irq_pend', 'Pending', 9, 9, 1, C.irq, true, '許された割り込みが待っている (WFI から起きる条件)', 'An enabled interrupt is pending (what wakes WFI)'),
    S('sie', 'SIE', 9, 10, 1, C.irq, true, 'mstatus.SIE: S モードで割り込みを受ける', 'mstatus.SIE: S mode takes interrupts'),
    S('mie_bit', 'MIE', 9, 11, 1, C.irq, false, 'mstatus.MIE: M モードで割り込みを受ける', 'mstatus.MIE: M mode takes interrupts'),
    S('mip', 'mip', 13, 0, 16, C.irq, false, 'mip の下 16 ビット', 'Low 16 bits of mip'),
    S('mie', 'mie', 13, 16, 16, C.irq, false, 'mie の下 16 ビット', 'Low 16 bits of mie'),
    // MMU
    S('itlb', 'ITLB', 0, 5, 1, C.mmu, true, '命令側の TLB を引き損ね、ページ表を引いている間 1', '1 while an instruction TLB miss walks the page table'),
    S('dtlb', 'DTLB', 0, 6, 1, C.mmu, true, 'データ側の TLB を引き損ね、ページ表を引いている間 1', '1 while a data TLB miss walks the page table'),
    S('satp', 'satp', 10, 0, 32, C.mmu, true, 'satp の下 32 ビット (ページ表の根)。プロセスが替わると変わる',
      'Low 32 bits of satp (the page table root). It changes when the process changes', 'hex32'),
    // L1 キャッシュ
    S('ireq', 'I$Req', 0, 15, 1, C.l1, false, 'コアが I$ に命令の読みを出した', 'The core asked the I$ for instructions'),
    S('dreq', 'D$Req', 9, 12, 1, C.l1, true, 'コアが D$ に読み書きを出した', 'The core sent a load or store to the D$'),
    S('dreq_cmd', 'D$Cmd', 9, 13, 5, C.l1, false, 'その種類 (ld・st・lr・sc・amo・fence・zero ...)', 'Its kind (ld, st, lr, sc, amo, fence, zero ...)', 'dcmd'),
    S('dreq_addr', 'D$Addr', 12, 0, 32, C.l1, true, 'その番地 (仮想、下 32 ビット)', 'Its address (virtual, low 32 bits)', 'hex32'),
    // パイプライン (PMU の事象)
    S('ev_br', 'Branch', 8, 5, 1, C.pipe, false, '条件分岐を実行した', 'A conditional branch executed'),
    S('ev_mispred', 'Mispred', 8, 6, 1, C.pipe, true, '分岐の予測が外れた (やり直し)', 'A branch was mispredicted (the pipeline restarts)'),
    S('ev_icmiss', 'I$Miss', 8, 7, 1, C.pipe, true, 'I$ を引き損ねた (行を読む)', 'I$ miss (a line is read)'),
    S('ev_dcmiss', 'D$Miss', 8, 8, 1, C.pipe, true, 'D$ を引き損ねた (行を読む)', 'D$ miss (a line is read)'),
    S('ev_dcwait', 'D$Wait', 8, 11, 1, C.pipe, true, 'D$ の答えを待って止まっている', 'Stalled, waiting for the D$'),
    S('ev_fe_empty', 'FEEmpty', 8, 12, 1, C.pipe, false, '命令が届かず、出す物が無い (フロントエンドが空)', 'Nothing to issue: the front end is empty'),
    S('ev_loaduse', 'LoadUse', 8, 13, 1, C.pipe, false, 'ロードの結果を待って止まった', 'Stalled on a load result (load-use)'),
    S('ev_unit', 'MulDiv', 8, 14, 1, C.pipe, false, '乗除算か FPU の答えを待っている', 'Waiting for the MDU or FPU'),
    S('ev_be_full', 'BEFull', 8, 17, 1, C.pipe, false, '後ろが詰まって出せない (バックエンドが満杯)', 'Cannot issue: the back end is full'),
    S('ev_l2rd', 'L2Rd', 8, 18, 1, C.pipe, false, 'L2 から L1 へ行を読んだ', 'L2 read (an L1 fill)'),
    S('ev_l2miss', 'L2Miss', 8, 19, 1, C.pipe, true, 'L2 を引き損ねた (主記憶へ行く)', 'L2 read miss (goes to main memory)'),
    S('ev_fills', 'Fills', 8, 22, 1, C.pipe, false, '行を読んでいる最中 (1 つ以上)', 'A line fill is in flight (one or more)'),
    S('ev_ipf', 'I$Pref', 8, 25, 1, C.pipe, false, 'I$ が先読みを出した', 'The I$ prefetched'),
    S('events', 'Events', 8, 0, 32, C.pipe, false, 'PMU の事象の全部 (mmRISC-2 の hpm_ev の 30 ビット)', 'All PMU events (the 30 bits of hpm_ev of mmRISC-2)', 'hex32'),
    // 主記憶 (AXI4)
    S('mem_rd', 'MemRd', 0, 7, 1, C.mem, true, '主記憶へ読みを出した (L2 の外。AR の受け渡し)', 'Read sent to main memory (outside the L2, AR handshake)'),
    S('mem_wr', 'MemWr', 0, 8, 1, C.mem, true, '主記憶へ書きを出した (AW の受け渡し)', 'Write sent to main memory (AW handshake)'),
    S('addr', 'Addr', 3, 0, 32, C.mem, true, '主記憶の番地 (物理、下 32 ビット)', 'Main memory address (physical, low 32 bits)', 'hex32'),
    S('rdata', 'RData', 0, 9, 1, C.mem, false, '読んだデータが 1 拍来た (R の受け渡し)', 'A beat of read data arrived (R handshake)'),
    S('wdata', 'WData', 0, 10, 1, C.mem, false, '書くデータを 1 拍出した (W の受け渡し)', 'A beat of write data went out (W handshake)'),
    S('data', 'Data', 4, 0, 32, C.mem, false, 'その拍のデータ (下 32 ビット)', 'The data of that beat (low 32 bits)', 'hex32'),
    // SoC
    S('sd_state', 'SD', 9, 18, 3, C.soc, true, 'SD カードの模型の状態 (idle・cmd・rd・wr ...)', 'State of the SD card model (idle, cmd, rd, wr ...)', 'sd'),
    S('sd_cmd_done', 'SDCmd', 9, 21, 1, C.soc, false, 'SD のコマンドが済んだ', 'An SD command finished'),
    S('sd_data_done', 'SDData', 9, 22, 1, C.soc, true, 'SD のデータの転送が済んだ (割り込みになる)', 'An SD data transfer finished (raises an interrupt)'),
    S('dma', 'DMA', 9, 25, 1, C.soc, false, 'SD の DMA が D$ を通して読み書きしている', 'The SD DMA is reading or writing through the D$'),
    S('plic_irq', 'PLIC', 9, 23, 1, C.soc, false, 'PLIC がコアに割り込みを上げている', 'The PLIC raises an interrupt to the core'),
    S('plic_claim', 'Claim', 9, 24, 1, C.soc, false, 'カーネルが PLIC から割り込みを claim した', 'The kernel claimed an interrupt from the PLIC'),
    // UART
    S('uart_rx', 'RX', 0, 12, 1, C.uart, true, '打った字が UART の受信 FIFO に入った', 'A typed key entered the UART receive FIFO'),
    S('uart_tx', 'TX', 0, 11, 1, C.uart, true, 'UART が 1 字送った', 'The UART sent a character'),
    S('uart_ch', 'Char', 0, 24, 8, C.uart, true, 'UART の字 (送信か受信)', 'The UART character (sent or received)', 'char'),
    // 時計
    S('cycle', 'Clock', 14, 0, 32, C.clk, false, '模型のクロック数 (下 32 ビット、10 進)。「事象だけ記録」の時に間を読む',
      'Model clock count (low 32 bits, decimal). Useful when only events are recorded', 'udec')
  ];
})();

// ---- 書式 ----
var MMRISC2_EXC = { 0: 'i-misalign', 1: 'i-fault', 2: 'illegal', 3: 'ebreak', 4: 'l-misalign', 5: 'l-fault',
  6: 's-misalign', 7: 's-fault', 8: 'ecall-U', 9: 'ecall-S', 11: 'ecall-M', 12: 'i-page', 13: 'l-page', 15: 's-page' };
var MMRISC2_IRQ = { 1: 'S-soft', 3: 'M-soft', 5: 'S-timer', 7: 'M-timer', 9: 'S-ext', 11: 'M-ext', 13: 'PMU' };
var MMRISC2_DCMD = { 0: 'ld', 1: 'st', 2: 'lr', 3: 'sc', 13: 'fence', 14: 'flush', 15: 'st-thr', 16: 'zero' };
var MMRISC2_SD = ['idle', 'cmd', 'rd', 'rd-gap', 'wr', 'wr-busy', '6', '7'];

function fmtCharMmrisc2(v) {
  var c = v & 0xff;
  if (c === 0x0d) return '\\r';
  if (c === 0x0a) return '\\n';
  if (c === 0x1b) return 'ESC';
  return (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : c.toString(16).padStart(2, '0');
}

function fmtCauseMmrisc2(v) {
  if (v === 0x7f) return '-';   // トラップでないクロック (harness.cpp の kNoCause)
  var code = v & 0x7f;
  var name = (v & 0x80) ? MMRISC2_IRQ[code] : MMRISC2_EXC[code];
  return name || ((v & 0x80) ? 'irq' : 'exc') + code;
}

// 命令の書式。波形の区間では幅に収まる長さ (読んだ形 → 名前だけ → 出さない)、値の欄では名前だけ
function fmtInsnMmrisc2(v, sig, ctx) {
  if (!ctx) return RVDIS.mnemonic(v);
  var zoom = (window.la && window.la._zoom) || 1;
  var w = (ctx.s1 - ctx.s0) * zoom;
  var pc = ctx.heapu32 ? ctx.heapu32[((ctx.s0 >>> 0) & (ctx.ringSize - 1)) * ctx.ringWords + 1] >>> 0 : undefined;
  var full = RVDIS.disasm(v, pc);
  if (full.length * 6.2 + 6 < w) return full;
  var m = RVDIS.mnemonic(v);
  return (m.length * 6.2 + 6 < w) ? m : null;
}

// ---- デコードレーン: 退役した命令を 1 つずつ、種類で色を分けて並べる ----
var MMRISC2_INSN_COLORS = {
  load: '#cfe3ff', store: '#ffd9c2', branch: '#e6d4ff', jump: '#d9c2ff', alu: '#e4ecdf', muldiv: '#c9efe4',
  csr: '#ffe9a8', system: '#ffb3b3', amo: '#ffc9e6', fp: '#d2f0f7', fence: '#eeeeee', illegal: '#ff8080'
};

var MMRISC2_DECODE_LANE = {
  label: 'Asm',
  render: function (ctx, p) {
    var RS = p.ringSize, RW = p.ringWords, H = p.heapu32;
    var y = p.decY + 2, h = p.decH - 4;
    var x0 = null, insn = 0, pc = 0;
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    var flush = function (xEnd) {
      if (x0 === null) return;
      var w = xEnd - x0;
      var d = RVDIS.decode(insn, pc);
      ctx.fillStyle = MMRISC2_INSN_COLORS[d.c] || '#eee';
      ctx.fillRect(x0, y, Math.max(w - 1, 1), h);
      if (w < 16) return;   // 縮めた時は色だけ (字を測るのは重い)
      var txt = d.a ? d.m + ' ' + d.a : d.m;
      if (ctx.measureText(txt).width + 4 > w) txt = d.m;
      if (ctx.measureText(txt).width + 4 <= w) {
        ctx.fillStyle = '#222';
        ctx.fillText(txt, x0 + 2, y + h - 4);
      }
    };
    for (var i = 0; i < p.samples; i++) {
      var base = (((p.startSamp + i) >>> 0) & (RS - 1)) * RW;
      if (!(H[base] & 1)) continue;
      var x = p.sigX + i * p.laZoom;
      flush(x);
      x0 = x;
      insn = H[base + 2] >>> 0;
      pc = H[base + 1] >>> 0;
    }
    flush(p.sigX + p.samples * p.laZoom);
  },
  // 値の欄: その時点までに最後に退役した命令の名前
  getValue: function (H, RS, RW, samp) {
    for (var k = 0; k < 64; k++) {
      var base = (((samp - k) >>> 0) & (RS - 1)) * RW;
      if (H[base] & 1) return RVDIS.mnemonic(H[base + 2] >>> 0);
    }
    return null;
  }
};

// 言語を決めて tip を文字にした信号の定義
function mmrisc2LaSignals(lang) {
  return MMRISC2_LA_SIGNALS.map(function (s) { return Object.assign({}, s, { tip: s.tip[lang] || s.tip.ja }); });
}

var MMRISC2_LA_CONFIG = {
  signals:       MMRISC2_LA_SIGNALS,
  width:         928,
  labelWidth:    64,
  trackH:        22,
  decodeLaneH:   22,
  storagePrefix: 'mmrisc2_la2_',   // 信号が増えたので、前の版の表示の設定は持ち越さない
  decodeLane:    MMRISC2_DECODE_LANE,
  groups: [
    { label: 'CPU',       color: MMRISC2_COLORS.cpu,  ids: ['retire', 'pc', 'insn', 'insn_hex', 'priv'] },
    { label: 'Writeback', color: MMRISC2_COLORS.reg,  ids: ['rd_we', 'rd', 'rd_data', 'rd_data_hi', 'rd2', 'rd2_data'] },
    { label: 'Trap',      color: MMRISC2_COLORS.trap, ids: ['trap', 'trap_int', 'cause', 'trap_to_s', 'epc', 'tval'] },
    { label: 'IRQ',       color: MMRISC2_COLORS.irq,
      ids: ['irq_mtimer', 'irq_mext', 'irq_sext', 'irq_msoft', 'stip', 'seip', 'irq_pend', 'sie', 'mie_bit', 'mip', 'mie'] },
    { label: 'MMU',       color: MMRISC2_COLORS.mmu,  ids: ['itlb', 'dtlb', 'satp'] },
    { label: 'L1',        color: MMRISC2_COLORS.l1,   ids: ['ireq', 'dreq', 'dreq_cmd', 'dreq_addr'] },
    { label: 'Pipeline',  color: MMRISC2_COLORS.pipe,
      ids: ['ev_br', 'ev_mispred', 'ev_icmiss', 'ev_dcmiss', 'ev_dcwait', 'ev_fe_empty', 'ev_loaduse', 'ev_unit',
            'ev_be_full', 'ev_l2rd', 'ev_l2miss', 'ev_fills', 'ev_ipf', 'events'] },
    { label: 'Memory',    color: MMRISC2_COLORS.mem,  ids: ['mem_rd', 'mem_wr', 'addr', 'rdata', 'wdata', 'data'] },
    { label: 'SoC',       color: MMRISC2_COLORS.soc,  ids: ['sd_state', 'sd_cmd_done', 'sd_data_done', 'dma', 'plic_irq', 'plic_claim'] },
    { label: 'UART',      color: MMRISC2_COLORS.uart, ids: ['uart_rx', 'uart_tx', 'uart_ch'] },
    { label: 'Clock',     color: MMRISC2_COLORS.clk,  ids: ['cycle'] }
  ],
  formatters: {
    // 既定の 16 進は 0x80000000 以上を負の数で出すので、符号なしで 8 桁にする
    hex32: function (v) { return (v >>> 0).toString(16).toUpperCase().padStart(8, '0'); },
    udec: function (v) { return String(v >>> 0); },
    priv: function (v) { return ['U', 'S', '?', 'M'][v & 3]; },
    char: function (v) { return fmtCharMmrisc2(v); },
    abi: function (v) { return RVDIS.ABI[v & 31]; },
    cause: function (v) { return fmtCauseMmrisc2(v); },
    dcmd: function (v) { return MMRISC2_DCMD[v] || (v >= 4 && v <= 12 ? 'amo' : String(v)); },
    sd: function (v) { return MMRISC2_SD[v & 7]; },
    insn: fmtInsnMmrisc2
  }
};

// トリガーのプリセット (sft-la-ctrl.js の triggerPresets)。post は発火後に記録するサンプル数
var MMRISC2_TRIGGER_PRESETS = [
  { label: '打鍵 / Key press', sig: 'uart_rx', mode: 'rise', post: 6000,
    tip: '打った字が UART に入った瞬間から。割り込み → カーネル → ash が動く / From the moment a typed key reaches the UART: interrupt, kernel, ash' },
  { label: 'U モード / U-mode', sig: 'priv', mode: 'eq', value: '0', post: 4000,
    tip: 'ユーザーのプログラム (ash や ls) の命令が退役し始めた所 / Where instructions of a user program (ash, ls) start to retire' },
  { label: 'sret (U へ戻る) / sret', sig: 'insn', mode: 'eq', value: '10200073', post: 4000,
    tip: 'カーネルが sret でユーザーへ戻る所 / Where the kernel returns to user mode with sret' },
  { label: 'システムコール / System call', sig: 'cause', mode: 'eq', value: '08', post: 6000,
    tip: 'ユーザーの ecall でトラップに入った所 (ecall は退役せず、トラップになる) / A trap by ecall from user mode (ecall does not retire; it traps)' },
  { label: 'S タイマー / S timer', sig: 'stip', mode: 'rise', post: 4000,
    tip: 'HZ=100 の刻みのタイマー割り込みが待ちになった所 / Where the HZ=100 timer interrupt becomes pending' },
  { label: 'SD の転送済み / SD done', sig: 'sd_data_done', mode: 'rise', post: 6000,
    tip: 'SD カードの模型がデータの転送を終えた所。割り込み → カーネルが起きる / Where the SD model finishes a transfer: interrupt, the kernel wakes' },
  { label: 'トラップ / Trap', sig: 'trap', mode: 'rise', post: 2000,
    tip: '例外か割り込みでトラップに入った所 / Entry to a trap, by an exception or an interrupt' },
  { label: 'DTLB ミス / DTLB miss', sig: 'dtlb', mode: 'rise', post: 2000,
    tip: 'データ側の TLB を引き損ねてページ表を引き始める所 / A data-side TLB miss, where the page table walk starts' }
];
