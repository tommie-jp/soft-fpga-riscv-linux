'use strict';
// regs-panel.js — レジスタの窓とトラップの記録 (Logic Analyzer の下に出す)
//
// worker.js の frame から 2 つを受ける:
//   regs        レジスタの窓 (tb の reg_sel の並び。1 つを下 32・上 32 ビットの 2 語で)。動いている間は今の値、
//               ring が止まっていれば止まった時の値 (regsFrozen)
//   ringSnap    ring の写し (la-defs.js の並び)
//
// 止まっている時は、Logic Analyzer のカーソル (無ければマーカー A、トリガー、最後) の時点の x レジスタを
// ring の書き戻し (rd_we・rd・rd_data) と 2 つの写し (止まった時・トリガーが発火した時) から組み立てる。
//   - その時点までに書いた記録があれば、最後の記録の値
//   - 無ければ写しの値。写しはサンプル a の直後に取った物で、a で書いた値はまだ入っていない
//     (書き戻しは次の立ち上がりで入る)。だから t の値に使えるのは、a <= t か、(t, a-1] に書き込みが無い時
//   - どれでもなければ分からない (?)
// ring には途切れがある (止めていた間も模型は回る。語 9 の [26] が途切れの後の最初のサンプル)。
// 書き込みも写しも、見ている時点と同じ途切れの間の物だけを使う
// f レジスタと CSR は止まった時の値だけ (ring に書き戻しの記録が無い)。
//
// rtlscope (la/rtlscope-la.js) は手を入れずに写した物なので、カーソルとマーカーの位置はその内部の
// 値 (_cursorViewX・_lastStartSamp・_markerA など) を読む。rtlscope を新しくしたら、ここを確かめる。
(function () {
  var CSR_NAMES = ['priv', 'mstatus', 'mie', 'mip', 'mtvec', 'mepc', 'mcause', 'mtval', 'mscratch', 'medeleg',
    'mideleg', 'sstatus', 'sie', 'sip', 'stvec', 'sepc', 'scause', 'stval', 'sscratch', 'satp', 'stimecmp',
    'mcycle', 'minstret', 'mtime', 'fcsr'];
  var CSR_BASE = 64;
  var W = { flags: 0, pc: 1, insn: 2, epc: 11, tval: 5, rdLo: 6, rdHi: 7, rdNo: 9, cycle: 14, rd2Lo: 15 };

  var TEXT = {
    ja: {
      live: '動作中の値 (約 0.1 秒ごと)', frozen: '止まった時の値', at: 'カーソルの時点',
      note: '? はその時点の値が ring と写しから分からない所。f と CSR は止まった時の値です', noTrap: 'ring にトラップはありません',
      cols: ['T', 'クロック', '原因', '行き先', 'EPC', 'tval'], jump: '押すとマーカー A をそこに置きます'
    },
    en: {
      live: 'Live values (every ~0.1 s)', frozen: 'Values when stopped', at: 'At the cursor',
      note: '? means the ring and the snapshots cannot tell the value at that point. f registers and CSRs are the values when stopped', noTrap: 'No traps in the ring',
      cols: ['T', 'Clock', 'Cause', 'To', 'EPC', 'tval'], jump: 'Click to put marker A there'
    }
  };

  function hex(lo, hi, digits) {
    var s = (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
    return digits ? s.slice(16 - digits) : s;
  }
  function h32(v) { return (v >>> 0).toString(16).padStart(8, '0'); }

  function RegsPanel(opts) {
    this.root = document.getElementById(opts.rootId);
    this.trapRoot = document.getElementById(opts.trapRootId);
    this.lang = opts.lang || function () { return 'ja'; };
    this.ringSize = opts.ringSize;
    this.ringWords = opts.ringWords;
    this.view = null;        // ring の写し
    this.head = 0;
    this.frozen = false;
    this.regs = null;        // Uint32Array (2 語ずつ)
    this.regsFrozen = false;
    this.regsFire = null;    // トリガーが発火した時の写し
    this.fireHead = -1;
    this.regsCycle = 0;      // regs を取った時のクロック数
    this.snapId = 0;         // ring の写しを受けるたびに増やす (トラップの記録を描き直す時を決める)
    this.prevShown = null;   // 前に出した x レジスタ (変わった所に印を付ける)
    this.key = '';           // 前に描いた時の状態 (同じなら描き直さない)
    this.trapKey = '';
    this._build();
  }

  RegsPanel.prototype._build = function () {
    this.root.innerHTML = '<div class="rp-head"></div><div class="rp-grid rp-x"></div>' +
      '<details class="rp-more"><summary>f0-f31</summary><div class="rp-grid rp-f"></div></details>' +
      '<details class="rp-more" open><summary>CSR</summary><div class="rp-grid rp-csr"></div></details>' +
      '<div class="rp-note"></div>';
    this.elHead = this.root.querySelector('.rp-head');
    this.elX = this.root.querySelector('.rp-x');
    this.elF = this.root.querySelector('.rp-f');
    this.elCsr = this.root.querySelector('.rp-csr');
    this.elNote = this.root.querySelector('.rp-note');
    var mk = function (host, names) {
      return names.map(function (n) {
        var cell = document.createElement('div');
        cell.className = 'rp-cell';
        cell.innerHTML = '<span class="rp-name">' + n + '</span><span class="rp-val"></span>';
        host.appendChild(cell);
        return cell;
      });
    };
    this.cellsX = mk(this.elX, RVDIS.ABI.map(function (n, i) { return 'x' + i + ' ' + n; }));
    this.cellsF = mk(this.elF, RVDIS.FABI.map(function (n, i) { return 'f' + i + ' ' + n; }));
    this.cellsCsr = mk(this.elCsr, CSR_NAMES);
  };

  // worker の frame を受ける (lag.frame と同じ物)
  RegsPanel.prototype.frame = function (m) {
    this.head = m.head >>> 0;
    this.frozen = !!m.frozen;
    if (m.ringSnap && m.ringSnap.byteLength > 0) { this.view = new Uint32Array(m.ringSnap); this.snapId++; }
    if (m.regs) {
      this.regs = new Uint32Array(m.regs);
      this.regsFrozen = !!m.regsFrozen;
      this.regsFire = m.regsFire ? new Uint32Array(m.regsFire) : null;
      this.fireHead = m.trigFireHead | 0;
      this.regsCycle = m.regsCycle || 0;
    }
  };

  RegsPanel.prototype._word = function (samp, w) {
    return this.view[((samp >>> 0) & (this.ringSize - 1)) * this.ringWords + w] >>> 0;
  };

  // 見ている時点 (サンプルの通し番号)。カーソル → マーカー A → トリガー → 最後
  RegsPanel.prototype._focus = function (la) {
    if (this.head === 0) return -1;
    var s = -1;
    if (la._cursorViewX >= 0 && la._zoom) s = la._lastStartSamp + Math.floor((la._cursorViewX + (la._lastSubPx || 0)) / la._zoom);
    else if (la._markerAOn && la._markerA !== null) s = la._markerA;
    else if (la._trigOn && la._trigHead >= 0) s = la._trigHead;
    var oldest = Math.max(0, this.head - this.ringSize);
    if (s < oldest || s > this.head - 1) s = this.head - 1;
    return s;
  };

  // samp の時点の x レジスタ。{ lo, hi, known, wroteHere }
  RegsPanel.prototype._xAt = function (samp) {
    var oldest = Math.max(0, this.head - this.ringSize);
    // samp を含む途切れの間 [lo, hi]
    var lo = oldest, hi = this.head - 1;
    for (var g = samp; g > oldest; g--) if (this._word(g, W.rdNo) & (1 << 26)) { lo = g; break; }
    for (var g2 = samp + 1; g2 < this.head; g2++) if (this._word(g2, W.rdNo) & (1 << 26)) { hi = g2 - 1; break; }
    var writes = [];   // レジスタごとの書き込みのサンプル (古い順)
    for (var i = 0; i < 32; i++) writes.push([]);
    for (var s = lo; s <= hi; s++) {
      if (this._word(s, W.flags) & (1 << 13)) writes[this._word(s, W.rdNo) & 31].push({ s: s, w: W.rdLo });
      var r2 = this._word(s, W.rdNo) >>> 27;   // 2 つ目の書き込み (FPU の答えが整数の時など)
      if (r2) writes[r2].push({ s: s, w: W.rd2Lo });
    }
    // 写し: サンプル a の直後の値。同じ途切れの間にある物だけ。発火のサンプルは trigFireHead - 1
    // 止まった時の写しは、最後のサンプルと同じクロックで取ったなら、そのサンプルの書き込みをまだ含まない。
    // 「事象のあるクロックだけ」の Hold では間に記録の無いクロックが挟まり、含む (incl)
    var anchors = [];
    if (this.regsFrozen && hi === this.head - 1) {
      var incl = (this.regsCycle % 4294967296) !== this._word(this.head - 1, W.cycle);
      anchors.push({ a: this.head - 1, regs: this.regs, incl: incl });
    }
    var fa = this.fireHead - 1;
    if (this.regsFire && fa >= lo && fa <= hi) anchors.push({ a: fa, regs: this.regsFire, incl: false });
    var out = [{ lo: 0, hi: 0, known: true, wroteHere: false }];
    for (var r = 1; r < 32; r++) {
      var ws = writes[r], last = null;
      for (var k = 0; k < ws.length && ws[k].s <= samp; k++) last = ws[k];
      if (last) {
        out.push({ lo: this._word(last.s, last.w), hi: this._word(last.s, last.w + 1), known: true, wroteHere: last.s === samp });
        continue;
      }
      var hit = null;
      for (var j = 0; j < anchors.length && !hit; j++) {
        var an = anchors[j];
        // samp までに書き込みは無い。a <= samp なら写しがそのまま、a > samp なら (samp, a-1] に書き込みが無い時だけ
        var end = an.incl ? an.a : an.a - 1;
        var clean = an.a <= samp || !ws.some(function (w) { return w.s > samp && w.s <= end; });
        if (clean) hit = an.regs;
      }
      out.push(hit ? { lo: hit[2 * r], hi: hit[2 * r + 1], known: true, wroteHere: false }
                   : { lo: 0, hi: 0, known: false, wroteHere: false });
    }
    return out;
  };

  // 毎フレーム呼ぶ。見ている時点か中身が変わった時だけ描き直す
  RegsPanel.prototype.draw = function (la) {
    if (!this.regs) return;
    var t = TEXT[this.lang()];
    var useRing = this.frozen && this.view && this.view.length > 0 && la;
    var samp = useRing ? this._focus(la) : -1;
    var key = [this.lang(), useRing, samp, this.head, this.regs[0], this.regs[2 * 85], this.regsFrozen, this.fireHead,
      this.regsFire ? this.regsFire[2 * 85] : 0].join(',');
    if (key === this.key) return;
    this.key = key;

    var xs, head;
    if (useRing && samp >= 0) {
      xs = this._xAt(samp);
      // その時点までに最後に退役した命令
      var pc = null, priv = 0, insn = 0;
      for (var s = samp; s >= Math.max(0, this.head - this.ringSize); s--) {
        var f = this._word(s, W.flags);
        if (f & 1) { pc = this._word(s, W.pc); insn = this._word(s, W.insn); priv = (f >> 3) & 3; break; }
      }
      var tBase = (la._trigOn && la._trigHead >= 0) ? la._trigHead : this.head - 1;
      var tRel = samp - tBase;
      head = t.at + ' T=' + (tRel > 0 ? '+' : '') + tRel + ' · clk ' + this._word(samp, W.cycle).toLocaleString('en') +
        (pc !== null ? ' · PC ' + h32(pc) + ' ' + ['U', 'S', '?', 'M'][priv] + ' · ' + RVDIS.disasm(insn, pc) : '');
    } else {
      xs = [];
      for (var i = 0; i < 32; i++) xs.push({ lo: this.regs[2 * i], hi: this.regs[2 * i + 1], known: true, wroteHere: false });
      head = this.regsFrozen ? t.frozen : t.live;
    }
    this.elHead.textContent = head;

    var prev = this.prevShown;
    for (var r = 0; r < 32; r++) {
      var x = xs[r], cell = this.cellsX[r], val = cell.lastChild;
      val.textContent = x.known ? hex(x.lo, x.hi) : '????????????????';
      var changed = prev && x.known && prev[r].known && (prev[r].lo !== x.lo || prev[r].hi !== x.hi);
      cell.className = 'rp-cell' + (x.wroteHere ? ' rp-wrote' : changed ? ' rp-changed' : '') + (x.known ? '' : ' rp-unknown');
    }
    this.prevShown = xs;
    for (var k = 0; k < 32; k++) this.cellsF[k].lastChild.textContent = hex(this.regs[2 * (32 + k)], this.regs[2 * (32 + k) + 1]);
    for (var c = 0; c < CSR_NAMES.length; c++) {
      var lo = this.regs[2 * (CSR_BASE + c)], hi = this.regs[2 * (CSR_BASE + c) + 1];
      var v = hex(lo, hi), name = CSR_NAMES[c];
      if (name === 'priv') v = ['U', 'S', '?', 'M'][lo & 3];
      else if (name === 'mcause' || name === 'scause') v += ' ' + fmtCauseMmrisc2(((hi >>> 31) ? 0x80 : 0) | (lo & 0x7f));
      else if (name === 'fcsr') v = hex(lo, 0, 2);
      this.cellsCsr[c].lastChild.textContent = v;
    }
    this.elNote.textContent = useRing ? t.note : '';
  };

  // ring の中のトラップを新しい順に並べる。行を押すとマーカー A をそこに置く
  RegsPanel.prototype.drawTraps = function (la) {
    if (!this.trapRoot || !this.view || this.view.length === 0) return;
    var key = [this.lang(), this.snapId, la && la._trigHead].join(',');
    if (key === this.trapKey) return;
    this.trapKey = key;
    var t = TEXT[this.lang()];
    var rows = [];
    var oldest = Math.max(0, this.head - this.ringSize);
    var tBase = (la && la._trigOn && la._trigHead >= 0) ? la._trigHead : this.head - 1;
    for (var s = this.head - 1; s >= oldest && rows.length < 40; s--) {
      var f = this._word(s, W.flags);
      if (!(f & 2)) continue;
      rows.push({ s: s, f: f });
    }
    if (rows.length === 0) { this.trapRoot.textContent = t.noTrap; return; }
    var self = this;
    var html = '<table class="rp-traps"><tr>' + t.cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr>';
    rows.forEach(function (r) {
      var rel = r.s - tBase;
      html += '<tr data-s="' + r.s + '" title="' + t.jump + '"><td>' + (rel > 0 ? '+' : '') + rel + '</td><td>' +
        self._word(r.s, W.cycle).toLocaleString('en') + '</td><td>' + fmtCauseMmrisc2((r.f >>> 16) & 0xff) +
        '</td><td>' + ((r.f & (1 << 14)) ? 'S' : 'M') + '</td><td>' + h32(self._word(r.s, W.epc)) + '</td><td>' +
        h32(self._word(r.s, W.tval)) + '</td></tr>';
    });
    this.trapRoot.innerHTML = html + '</table>';
    this.trapRoot.querySelectorAll('tr[data-s]').forEach(function (tr) {
      tr.addEventListener('click', function () { if (la) RegsPanel.jumpTo(la, +tr.dataset.s); });
    });
  };

  // マーカー A を samp に置き、そこが真ん中に来るように送る (rtlscope の内部の値を使う)
  RegsPanel.jumpTo = function (la, samp) {
    la._markerA = samp;
    la._markerAOn = true;
    if (la._markerBtnApply && la._markerBtnApply.A) la._markerBtnApply.A();
    // 見えているサンプル数。画面の外では描かないので _lastSamplesInView は古いことがある (rtlscope の update と同じ式)
    var sv = Math.ceil(la._VIEW_W / la._zoom);
    la._pan = Math.max(0, (la._lastHead >>> 0) - samp - Math.floor(sv / 2));
    la._panOverride = true;
    if (la._schedDraw) la._schedDraw();
  };

  window.RegsPanel = RegsPanel;
})();
