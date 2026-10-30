// 元: soft-FPGA (https://github.com/tommie-jp/soft-fpga) の js/rtlscope-la.js (soft-FPGA f59a45c、2026-10-17)。手を入れずに写した
/**
 * rtlscope-la.js  — RTLScopeLA: 汎用ロジックアナライザ Canvas ライブラリ
 *
 * IIFE + window.RTLScopeLA としてエクスポートする。
 * 8080 固有コード (M-CYC デコード, fmtFlags8080, CPM_REGIONS 背景色, T-state) は
 * コンストラクタ config のコールバックで注入する。
 *
 * 版 (RTLScopeLA.VERSION)。描画や既定値を変えたら上げる。画面の「Logic Analyzer」の右 (#la-ver) に出る。
 *   1.0.0  最初の版
 *   1.1.0  描画を軽くする (バス信号の線をまとめる・細かい区間を帯に・変化なし/画面外で描かない)。Hatch の既定を OFF
 *   1.2.0  画面の Freeze / Thaw を Hold / Resume に改名する (関数名・回路側の API は freeze / thaw のまま)
 *   1.2.1  1x で値が毎サンプル変わるバス信号 (区間がちょうど 1 px) も busy の帯にまとめ、描く命令を減らす (91-pong の 1x で 23 fps → 60 fps)
 *   1.3.0  波形の左の信号名にツールチップ (信号名・フルネーム・幅と形式・説明) を出す。name / tip は文字列か { ja, en }。設定 lang / labelTooltips
 */
(function(global) {
  'use strict';

  var VERSION = '1.3.0';

  // ---- ズームレベル定義 ----
  var LA_ZOOM_LEVELS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];

  // ---- 信号名ツールチップの部品（DOM に触れない純粋関数。試験できるよう静的に公開する） ----
  var TIP_WORDS = { ja: { bit: 'ビット' }, en: { bit: 'bit' } };

  /** 使う言語。設定 lang → <html lang> → ブラウザの言語 → 'ja'。'ja' か 'en' に丸める */
  function _pickLang(cfg) {
    var l = cfg || (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) ||
            (typeof navigator !== 'undefined' && navigator.language) || 'ja';
    return String(l).slice(0, 2).toLowerCase() === 'en' ? 'en' : 'ja';
  }

  /** 文字列か { ja, en } を、言語に合わせて文字列にする。無い側は ja → en の順に探す */
  function _tr(v, lang) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    return v[lang] || v.ja || v.en || '';
  }

  /** ラベル欄の縦位置 ly（canvas の論理 px）から、アクティブ信号の番号を返す。レーンの外は -1 */
  function _laneIndex(ly, g) {
    if (g.n <= 0) return -1;
    var sigH = g.laH - g.markerLaneH - 2 * g.rulerH - g.decOff;
    var tH   = sigH / g.n;
    var idx  = Math.floor((ly - g.rulerH - g.decOff) / tH);
    return (idx >= 0 && idx < g.n && ly < g.rulerH + g.decOff + sigH) ? idx : -1;
  }

  /** 値の形式名（ラベル欄の右下に出す Bin / Dec / Hex …） */
  function _formatName(sig, cbFmt) {
    if (sig.type === 'bit')                            return 'Bin';
    if (sig.fmt === 'oct')                             return 'Oct';
    if (sig.fmt === 'dec' || sig.type === 'dec')       return 'Dec';
    if (sig.fmt && cbFmt && cbFmt[sig.fmt])            return sig.fmt;
    return 'Hex';
  }

  /** ツールチップの 3 段: { title: 信号名 + フルネーム, meta: 幅と形式, body: 説明 } */
  function _tipContent(sig, lang, cbFmt) {
    var name  = _tr(sig.name, lang);
    var width = sig.width || 1;
    return {
      title: (name && name !== sig.label) ? sig.label + '  ' + name : sig.label,
      meta:  width + ' ' + TIP_WORDS[lang].bit + ' · ' + _formatName(sig, cbFmt),
      body:  _tr(sig.tip, lang)
    };
  }

  /**
   * 網目（ハッチング）描画ヘルパー。
   * ctx は既に save() 済み・clip 済みの前提で呼ぶ。
   * type: 0=/ 右上がり  1=\ 右下がり  2=× 斜め格子  3=+ 直角格子
   */
  function _drawHatch(ctx, x0, x1, y0, y1, type, sp) {
    var h = y1 - y0;
    ctx.beginPath();
    if (type === 0 || type === 2) {   // / 右上がり斜線
      for (var x = x0 - h; x < x1 + h; x += sp) {
        ctx.moveTo(x, y1); ctx.lineTo(x + h, y0);
      }
    }
    if (type === 1 || type === 2) {   // \ 右下がり斜線
      for (var x = x0 - h; x < x1 + h; x += sp) {
        ctx.moveTo(x, y0); ctx.lineTo(x + h, y1);
      }
    }
    if (type === 3) {                 // + 直角格子
      for (var x = x0; x < x1 + sp; x += sp) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
      for (var y = y0; y < y1 + sp; y += sp)  { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    }
    ctx.stroke();
  }

  /**
   * RTLScopeLA コンストラクタ
   *
   * @param {Object} config
   *   canvasId        {string}   Canvas 要素の ID (default: 'la')
   *   togglesId       {string}   トグル UI 挿入先の ID (default: 'la-toggles')
   *   signals         {Array}    信号定義配列
   *   groups          {Array}    グループ定義配列
   *   ringSize        {number}   リングバッファのサンプル数 (default: 4096)
   *   ringWords       {number}   1サンプルあたりのワード数 (default: 6)
   *   storagePrefix   {string}   localStorage プレフィックス (default: 'la_')
   *   width           {number}   キャンバス幅 (default: 900)
   *   labelWidth      {number}   ラベル幅 (default: 56)
   *   trackH          {number}   1トラックの高さ (default: 28)
   *   timeRulerH      {number}   時間ルーラーの高さ (default: 14)
   *   decodeLaneH     {number}   デコードレーン高さ (default: 22)
   *   decodeLane      {Object}   { label, render(ctx, params) } — null で非表示
   *   formatters      {Object}   { fmtName: fn(val)→str }
   *   signalBackground {Function} fn(sig, val) → fillStyle文字列 or null
   *   getTState       {Function} fn(word0) → number (T-state 番号); null でグリッド線なし
   *   getCursorExtra  {Function} fn(heapu32, ringSize, ringWords, absIdx) → str or null
   */
  function RTLScopeLA(config) {
    // 版を「Logic Analyzer」の右に出す (#la-ver はページかツールバーが置く。無ければ何もしない)
    var verEl = document.getElementById('la-ver');
    if (verEl) verEl.textContent = 'v' + VERSION;
    var self = this;
    var c = config || {};

    // ---- 設定値の保存 ----
    self._canvasId      = c.canvasId      || 'la';
    self._togglesId     = c.togglesId     || 'la-toggles';
    self._signals       = c.signals       || [];
    self._groups        = c.groups        || [];
    self._ringSize      = c.ringSize      || 4096;
    self._RW            = c.ringWords     || 6;
    self._prefix        = c.storagePrefix !== undefined ? c.storagePrefix : 'la_';
    self._initLA_W      = c.width         || 900;   // ユーザー指定の最大幅
    self._LA_W          = self._initLA_W;            // 実効幅（_updateCanvas で更新）
    self._LABEL_W         = c.labelWidth      || 56;
    self._numberedLabels  = c.numberedLabels  || false;  // 信号レーン名に連番を付加
    self._labelTooltips   = c.labelTooltips   !== false; // 信号名のツールチップ（デフォルト ON）
    self._lang            = _pickLang(c.lang);           // 'ja' | 'en'（name / tip が { ja, en } のとき選ぶ）
    self._fillEnabled     = c.fillEnabled    !== false; // 塗りつぶし（デフォルト ON）
    self._hatchEnabled    = c.hatchEnabled   === true;  // 網目パターン（デフォルト OFF。描画が重いので明示したときだけ）
    self._TRACK_H         = c.trackH          || 28;
    self._TIME_RULER_H    = c.timeRulerH      || 14;
    self._MARKER_LANE_H = c.markerLaneH   || 18;  // マーカーラベル専用帯の高さ
    self._DEC_LANE_H    = c.decodeLaneH   || 22;

    // ---- コールバック ----
    self._cbDec         = c.decodeLane      || null;
    self._cbFmt         = c.formatters      || {};
    self._cbBg          = c.signalBackground || null;
    self._cbTs          = c.getTState       || null;
    self._cbCurExtra    = c.getCursorExtra   || null;

    // ---- 派生定数 ----
    self._VIEW_W = self._LA_W - self._LABEL_W;
    self._valColsW = 0;  // 値カラム合計幅（_draw で更新）
    self._valColW  = c.valColW || 44;  // 値カラム1本の幅

    // ---- 状態変数 ----
    self._zoomIdx      = 2;   // 初期: 1x
    self._zoom         = 1;
    self._pan          = 0;
    self._cursorViewX  = -1;
    self._markerA      = null;
    self._markerB      = null;
    self._markerC      = null;
    self._markerAOn    = false;
    self._markerBOn    = false;
    self._markerCOn    = false;
    self._trigOn       = false;
    self._lastStartSamp = 0;
    self._lastHead     = 0;
    self._frozen       = false;
    self._on           = true;
    self._tDragIdx     = null;
    self._tDragY       = 0;
    self._trigHead     = -1;
    self._touchActive  = false;   // タッチ操作中フラグ（pan リセット抑止）
    self._panOverride  = false;   // ナビボタンによる pan 維持フラグ
    self._markerDrag   = null;    // 'A' | 'B' | 'C' | null (マーカードラッグ中)
    self._markerBtnApply = { A: null, B: null, C: null };  // toggles ボタンのスタイル更新 ref
    self._lastHeapu32  = null;    // update() でキャッシュした WASM メモリビュー（RAF 再描画用）
    self._rafPending   = false;   // requestAnimationFrame 発行済みフラグ
    self._tipIdx       = -1;      // ツールチップを出している (出す予定の) 信号の番号
    self._tipTimer     = null;
    self._tipPress     = null;
    self._tipEl        = null;

    // ナビゲーションボタン ID (config で上書き可能)
    self._navLL    = c.navLL    || 'la-nav-ll';
    self._navL     = c.navL     || 'la-nav-l';
    self._navR     = c.navR     || 'la-nav-r';
    self._navRR    = c.navRR    || 'la-nav-rr';
    self._markersId = c.markersId || null;   // マーカーボタン挿入先 ID（null で togglesId に同居）

    // ナビ用に draw で更新する状態
    self._lastSamplesInView = 0;
    self._lastTotalAvail    = 0;

    // デコードレーン表示状態
    self._showDec = localStorage.getItem(self._prefix + 'decode_lane') !== '0';

    // ---- visible フラグを localStorage から復元 ----
    self._sigVisible = {};
    self._signals.forEach(function(s) {
      var saved = localStorage.getItem(self._prefix + 'sig_' + s.id);
      self._sigVisible[s.id] = saved !== null ? saved === '1' : s.on;
    });

    // ---- 信号の表示順 (localStorage から復元) ----
    self._sigOrder = self._signals.map(function(s) { return s.id; });
    (function() {
      try {
        var sv = localStorage.getItem(self._prefix + 'sig_order');
        if (!sv) return;
        var parsed = JSON.parse(sv);
        var allIds = self._signals.map(function(s) { return s.id; });
        if (Array.isArray(parsed) &&
            allIds.every(function(id) { return parsed.indexOf(id) >= 0; })) {
          self._sigOrder = parsed;
        }
      } catch(e) {}
    })();

    // ---- Canvas / DPR 初期化 ----
    self._ctx  = null;
    self._laH  = 0;

    self._updateCanvas();
    self._bindEvents();
  }

  // ==================== 信号名ツールチップ ====================

  var TIP_DELAY_MS = 300;    // マウス: 乗せてから出るまで
  var TIP_PRESS_MS = 500;    // タッチ: 長押しで出るまで

  /** いまの画面の、ラベル欄の縦位置 → アクティブ信号の番号 */
  RTLScopeLA.prototype._labelLaneAt = function(ly) {
    var sigs = this._getActiveSigs();
    return _laneIndex(ly, {
      laH: this._laH, markerLaneH: this._MARKER_LANE_H, rulerH: this._TIME_RULER_H,
      decOff: (this._showDec && this._cbDec) ? this._DEC_LANE_H : 0, n: sigs.length
    });
  };

  RTLScopeLA.prototype._tipHide = function() {
    if (this._tipTimer) { clearTimeout(this._tipTimer); this._tipTimer = null; }
    this._tipIdx = -1;
    if (this._tipEl) this._tipEl.style.display = 'none';
  };

  /** 信号 sig の説明を (x, y) の近くに出す。画面の端ではみ出すなら反対側へ寄せる */
  RTLScopeLA.prototype._tipShow = function(sig, x, y) {
    var c = _tipContent(sig, this._lang, this._cbFmt);
    var el = this._tipEl;
    if (!el) {
      el = this._tipEl = document.createElement('div');
      el.setAttribute('role', 'tooltip');
      el.style.cssText = 'position:fixed;z-index:10000;display:none;pointer-events:none;max-width:320px;' +
        'padding:6px 9px;border-radius:4px;background:rgba(30,30,40,0.95);color:#eee;font:12px/1.5 sans-serif;' +
        'box-shadow:0 2px 8px rgba(0,0,0,0.35);';
      document.body.appendChild(el);
    }
    el.textContent = '';
    var t = document.createElement('div');
    t.style.cssText = 'font-weight:bold;font-family:monospace;color:#fff;';
    t.textContent = c.title;
    var m = document.createElement('div');
    m.style.cssText = 'font-size:10px;color:#9ab;margin-bottom:2px;';
    m.textContent = c.meta;
    el.appendChild(t); el.appendChild(m);
    if (c.body) { var b = document.createElement('div'); b.textContent = c.body; el.appendChild(b); }
    el.style.display = 'block';
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = x + 14, top = y + 16;
    if (left + w > window.innerWidth  - 4) left = Math.max(4, x - w - 10);
    if (top  + h > window.innerHeight - 4) top  = Math.max(4, y - h - 10);
    el.style.left = left + 'px'; el.style.top = top + 'px';
  };

  /**
   * ポインタがラベル欄の (lx, ly) にある。lx < 0 は「ラベル欄の外」。
   * 同じレーンの上なら動かさず、別のレーンに移ったら出し直す。
   */
  RTLScopeLA.prototype._tipHover = function(lx, ly, cx, cy) {
    if (!this._labelTooltips || this._tDragIdx !== null || this._markerDrag) { this._tipHide(); return; }
    var idx = (lx >= 0 && lx < this._LABEL_W) ? this._labelLaneAt(ly) : -1;
    if (idx < 0) { this._tipHide(); return; }
    if (idx === this._tipIdx) return;
    this._tipHide();
    this._tipIdx = idx;
    var self = this;
    this._tipTimer = setTimeout(function() {
      self._tipTimer = null;
      var sig = self._getActiveSigs()[idx];
      if (sig && self._tipIdx === idx) self._tipShow(sig, cx, cy);
    }, TIP_DELAY_MS);
  };

  // ==================== パブリック API ====================

  /**
   * RAF ループから呼ぶ。フレームデータを受け取り描画する。
   */
  RTLScopeLA.prototype.update = function(head, heapu32, frozen, trigFireHead) {
    this.setFrozen(!!frozen);
    if (trigFireHead !== undefined && trigFireHead !== null) {
      var newTrig = (trigFireHead !== -1) ? (trigFireHead >>> 0) : -1;
      // 新しいトリガー発火を検出 → Trig を自動 ON してビュー中央に移動
      if (newTrig !== -1 && newTrig !== this._trigHead) {
        this._trigHead = newTrig;
        this._trigOn   = true;
        if (this._trigBtnApply) this._trigBtnApply();
        // head との距離から pan を計算してトリガーをビュー中央へ
        var h = head >>> 0;
        var samplesInView = Math.ceil(this._VIEW_W / this._zoom);
        var trigOffset = (h - newTrig) >>> 0;
        this._pan = Math.max(0, trigOffset - Math.floor(samplesInView / 2));
        this._panOverride = true;
      } else {
        this._trigHead = newTrig;
      }
    }
    this._lastHeapu32 = heapu32;          // RAF 再描画用にキャッシュ
    this._lastHead    = head >>> 0;
    if (!this._on || !this._ctx) return;
    if (this._inView === false) return;   // 画面の外: 見えるようになったら描く (_bindEvents の IntersectionObserver)
    var key = this._drawKey(heapu32, head >>> 0);
    if (key === this._lastDrawKey) return; // 前回と同じ絵になる: 描き直さない (Freeze 中・Pause 中)
    this._lastDrawKey = key;
    this._draw(heapu32, head >>> 0);
  };

  /**
   * 絵を決める状態をまとめた鍵。update() はこれが前回と同じなら描画を飛ばす。
   * head が同じでもリングが書き換わっている場合に備え、最新サンプルの word も入れる。
   * ここに無い状態を変える操作は、自分で _schedDraw() するか _lastDrawKey を null にすること。
   */
  RTLScopeLA.prototype._drawKey = function(heapu32, head) {
    var RW = this._RW, last = [];
    if (head > 0 && heapu32) {
      var base = ((head - 1) & (this._ringSize - 1)) * RW;
      for (var w = 0; w < RW; w++) last.push(heapu32[base + w]);
    }
    var vis = [];
    for (var i = 0; i < this._sigOrder.length; i++) if (this._sigVisible[this._sigOrder[i]]) vis.push(this._sigOrder[i]);
    return [head, last.join(','), this._frozen, this._trigHead, this._trigOn, this._pan, this._zoom,
            this._cursorViewX, this._markerA, this._markerB, this._markerC,
            this._markerAOn, this._markerBOn, this._markerCOn, this._markerDrag, this._tDragIdx, this._tDragY,
            this._fillEnabled, this._hatchEnabled, this._showDec, this._LA_W, this._laH, this._dpr,
            vis.join(',')].join('|');
  };

  /**
   * 次フレームで _draw() を呼ぶようスケジュールする。
   * マウス/タッチ操作によるパン・カーソル変化をスムーズに描画するために使う。
   * update() が同フレームで呼ばれる場合は RAF がキャンセルされるため二重描画はない。
   */
  RTLScopeLA.prototype._schedDraw = function() {
    if (this._rafPending || !this._on || !this._ctx || !this._lastHeapu32) return;
    this._rafPending = true;
    var self = this;
    requestAnimationFrame(function() {
      self._rafPending = false;
      if (self._on && self._ctx && self._lastHeapu32) {
        self._draw(self._lastHeapu32, self._lastHead);
      }
    });
  };

  /** ズームインデックスを設定する */
  RTLScopeLA.prototype.setZoom = function(idx) {
    var self = this;
    var oldZoom = self._zoom;
    self._zoomIdx = Math.max(0, Math.min(LA_ZOOM_LEVELS.length - 1, idx));
    self._zoom    = LA_ZOOM_LEVELS[self._zoomIdx];
    // ドロップダウン と レガシー lbl 両方を更新
    var sel = document.getElementById('la-zoom-sel');
    if (sel) sel.value = String(self._zoomIdx);
    var lbl = document.getElementById('la-zoom-lbl');
    if (lbl) lbl.textContent = self._zoom >= 1 ? self._zoom + 'x' : '1/' + Math.round(1 / self._zoom) + 'x';

    // カーソル中心ズーム（フリーズ中のみ）
    if (self._frozen) {
      var focusViewX = (self._cursorViewX >= 0 && self._cursorViewX <= self._VIEW_W)
                       ? self._cursorViewX
                       : self._VIEW_W / 2;
      var focusSamp     = self._lastStartSamp + Math.floor(focusViewX / oldZoom);
      var newSampInView = Math.ceil(self._VIEW_W / self._zoom);
      var newStartSamp  = focusSamp - Math.floor(focusViewX / self._zoom);
      self._pan = Math.max(0, (self._lastHead - newStartSamp - newSampInView) | 0);
    }
    self._schedDraw();
  };

  /** フリーズ状態を設定する */
  RTLScopeLA.prototype.setFrozen = function(b) {
    this._frozen = !!b;
    // タッチ操作中・ナビボタン pan 中は pan を維持する
    if (!b && !this._touchActive && !this._panOverride) this._pan = 0;
  };

  /** フリーズする */
  RTLScopeLA.prototype.freeze = function() { this.setFrozen(true); };

  /** フリーズ解除する */
  RTLScopeLA.prototype.thaw = function() { this.setFrozen(false); };

  /** ON/OFF を設定する */
  RTLScopeLA.prototype.setEnabled = function(b) {
    this._on = !!b;
    this._lastDrawKey = null;               // OFF の表示から戻ったら必ず描き直す
  };

  /** 信号塗りつぶし ON/OFF */
  RTLScopeLA.prototype.setFillEnabled = function(b) {
    this._fillEnabled = !!b;
  };

  /** 網目パターン ON/OFF */
  RTLScopeLA.prototype.setHatchEnabled = function(b) {
    this._hatchEnabled = !!b;
  };

  /** トリガー発火ヘッドを設定する */
  RTLScopeLA.prototype.setTrigFireHead = function(head) {
    this._trigHead = (head !== undefined && head !== null && head !== -1) ? (head >>> 0) : -1;
  };

  /**
   * トリガー位置をビュー内の指定位置へ移動する。
   * fracX は LA 全幅に対するトリガーマーカー x 位置の割合（省略時 0.5 = 中央）。
   * トリガーマーカー x = LABEL_W + off*zoom なので、x = LA_W*fracX となる off を逆算する。
   */
  RTLScopeLA.prototype.gotoTrig = function(fracX) {
    if (this._trigHead < 0) return;
    var samplesInView = Math.ceil(this._VIEW_W / this._zoom);
    var trigOffset    = ((this._lastHead >>> 0) - (this._trigHead >>> 0)) >>> 0;
    if (fracX === undefined || fracX === null) {
      this._pan = Math.max(0, trigOffset - Math.floor(samplesInView / 2));
      return;
    }
    var trigViewSamp = Math.round((fracX * this._LA_W - (this._LABEL_W + (this._valColsW || 0))) / this._zoom);
    this._pan = Math.max(0, trigOffset - (samplesInView - 1 - trigViewSamp));
  };

  // ---- getter ----
  Object.defineProperty(RTLScopeLA.prototype, 'zoom', {
    get: function() { return this._zoom; }
  });

  Object.defineProperty(RTLScopeLA.prototype, 'zoomLabel', {
    get: function() {
      return this._zoom >= 1 ? this._zoom + 'x' : '1/' + Math.round(1 / this._zoom) + 'x';
    }
  });

  Object.defineProperty(RTLScopeLA.prototype, 'frozen', {
    get: function() { return this._frozen; }
  });

  Object.defineProperty(RTLScopeLA.prototype, 'enabled', {
    get: function() { return this._on; }
  });

  // ==================== トグル UI ====================

  RTLScopeLA.prototype.buildToggles = function() {
    var self = this;

    var el = document.getElementById(self._togglesId);
    if (!el) return;

    // 既存コンテンツを破棄（再呼び出し対応）
    while (el.firstChild) el.removeChild(el.firstChild);

    // グループ色マップ: signal.id → group color
    var sigGroupColor = {};
    self._groups.forEach(function(grp) {
      var gc = grp.color || '#666';
      grp.ids.forEach(function(id) { sigGroupColor[id] = gc; });
    });

    // 折りたたみ状態
    var colKey = self._prefix + 'chips_collapsed';
    var collapsed = localStorage.getItem(colKey) === '1';

    // 折りたたみトグルボタン（左端）— #btn-la-collapse と完全同スタイル（インライン）
    var colBtn = document.createElement('button');
    colBtn.style.cssText =
      'background:#c8c8d8;color:#446;border:1px solid #aab;' +
      'padding:1px 4px;cursor:pointer;font-size:9px;line-height:1;' +
      'font-family:monospace;flex-shrink:0;transition:transform 0.15s;';
    colBtn.textContent = '▼';  // ▼
    colBtn.title = 'チップバーを折りたたむ / 展開する';
    el.appendChild(colBtn);

    // "Signal" ラベル（常時表示）
    var sigLabel = document.createElement('span');
    sigLabel.textContent = 'Signal';
    sigLabel.style.cssText = 'font-size:11px;color:#446;font-weight:bold;flex-shrink:0;align-self:center;';
    el.appendChild(sigLabel);

    // チップ群コンテナ
    var chipsDiv = document.createElement('div');
    chipsDiv.style.cssText = 'display:contents;';
    el.appendChild(chipsDiv);

    function applyCollapsed(c) {
      collapsed = c;
      localStorage.setItem(colKey, c ? '1' : '0');
      chipsDiv.style.display = c ? 'none' : 'contents';
      colBtn.style.transform = c ? 'rotate(-90deg)' : '';
    }
    applyCollapsed(collapsed);

    colBtn.addEventListener('click', function() {
      applyCollapsed(!collapsed);
    });

    // マーカーチップ生成ヘルパー
    function mkMarkerChip(label, colorOn, getOn, setOn, getSamp, setSamp) {
      var lbl = document.createElement('label');
      function applyStyle() {
        var on = getOn();
        lbl.className = 'sig-tog' + (on ? ' on' : '');
        lbl.style.background = on ? colorOn : '';
      }
      lbl.title = 'マーカー ' + label + ' ON/OFF';
      lbl.innerHTML = '<input type="checkbox"' + (getOn() ? ' checked' : '') +
                      '><span class="sw-track"></span> ' + label;
      var cb = lbl.querySelector('input');
      cb.addEventListener('change', function() {
        var next = this.checked;
        if (next && setSamp) {
          setSamp(self._lastStartSamp + Math.floor(self._lastSamplesInView / 2));
        }
        setOn(next);
        if (next && self._frozen && getSamp && getSamp() !== null) {
          var samp = getSamp();
          var sv   = self._lastSamplesInView;
          self._pan = Math.max(0, (self._lastHead >>> 0) - samp - Math.floor(sv / 2));
          self._panOverride = true;
        }
        applyStyle();
        self._schedDraw();
      });
      applyStyle();
      return { lbl: lbl, refresh: applyStyle };
    }

    // マーカーチップ: A, B, C, Trig
    var mA = mkMarkerChip('A', '#0064e6',
      function() { return self._markerAOn; },
      function(v) { self._markerAOn = v; },
      function() { return self._markerA; },
      function(s) { self._markerA = s; });
    self._markerBtnApply.A = mA.refresh;
    chipsDiv.appendChild(mA.lbl);

    var mB = mkMarkerChip('B', '#e07800',
      function() { return self._markerBOn; },
      function(v) { self._markerBOn = v; },
      function() { return self._markerB; },
      function(s) { self._markerB = s; });
    self._markerBtnApply.B = mB.refresh;
    chipsDiv.appendChild(mB.lbl);

    var mC = mkMarkerChip('C', '#00a050',
      function() { return self._markerCOn; },
      function(v) { self._markerCOn = v; },
      function() { return self._markerC; },
      function(s) { self._markerC = s; });
    self._markerBtnApply.C = mC.refresh;
    chipsDiv.appendChild(mC.lbl);

    var mTrig = mkMarkerChip('Trig', '#cc0000',
      function() { return self._trigOn; },
      function(v) { self._trigOn = v; },
      null, null);
    self._trigBtnApply = mTrig.refresh;
    chipsDiv.appendChild(mTrig.lbl);

    // デコードレーンチップ
    if (self._cbDec) {
      var decLabel = self._cbDec.label || 'DEC';
      var decChip = document.createElement('label');
      decChip.className = 'sig-tog' + (self._showDec ? ' on' : '');
      decChip.style.background = self._showDec ? '#445566' : '';
      decChip.title = 'マシンサイクルデコードレーンの表示切替';
      decChip.innerHTML = '<input type="checkbox"' + (self._showDec ? ' checked' : '') +
                          '><span class="sw-track"></span> ' + decLabel;
      var decCb = decChip.querySelector('input');
      decCb.addEventListener('change', function() {
        self._showDec = this.checked;
        localStorage.setItem(self._prefix + 'decode_lane', this.checked ? '1' : '0');
        decChip.className = 'sig-tog' + (this.checked ? ' on' : '');
        decChip.style.background = this.checked ? '#445566' : '';
        self._updateCanvas();
      });
      chipsDiv.appendChild(decChip);
    }

    // 全信号チップ（常に全表示、in-place トグル）
    self._sigOrder.forEach(function(id) {
      var s = null;
      for (var i = 0; i < self._signals.length; i++) {
        if (self._signals[i].id === id) { s = self._signals[i]; break; }
      }
      if (!s) return;
      var gc = sigGroupColor[id] || s.color || '#666';
      var isOn = !!self._sigVisible[s.id];
      var chip = document.createElement('label');
      chip.className = 'sig-tog' + (isOn ? ' on' : '');
      chip.style.background = isOn ? gc : '';
      if (s.tip) chip.title = s.tip;
      chip.innerHTML = '<input type="checkbox"' + (isOn ? ' checked' : '') +
                       '><span class="sw-track"></span> ' + s.label;
      var chipCb = chip.querySelector('input');
      chipCb.addEventListener('change', (function(sig, c, groupColor) {
        return function() {
          self._sigVisible[sig.id] = this.checked;
          localStorage.setItem(self._prefix + 'sig_' + sig.id, this.checked ? '1' : '0');
          c.className = 'sig-tog' + (this.checked ? ' on' : '');
          c.style.background = this.checked ? groupColor : '';
          self._updateCanvas();
        };
      })(s, chip, gc));
      chipsDiv.appendChild(chip);
    });
  };

  // ==================== LA OFF 表示 ====================

  RTLScopeLA.prototype._drawOff = function() {
    if (!this._ctx) return;
    var ctx = this._ctx;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, this._LA_W, this._laH || 60);
    ctx.fillStyle = '#aaa';
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Logic Analyzer OFF  (速度優先モード)', this._LA_W / 2, (this._laH || 60) / 2 + 5);
  };

  // ==================== 内部: アクティブ信号取得 ====================

  RTLScopeLA.prototype._getActiveSigs = function() {
    var self = this;
    return self._sigOrder
      .map(function(id) {
        for (var i = 0; i < self._signals.length; i++) {
          if (self._signals[i].id === id) return self._signals[i];
        }
        return null;
      })
      .filter(function(s) { return s && self._sigVisible[s.id]; });
  };

  // ==================== 内部: Canvas リサイズ ====================

  RTLScopeLA.prototype._updateCanvas = function() {
    var self = this;
    var canvas = document.getElementById(self._canvasId);
    if (!canvas) return;

    // DPR を毎回取得（ブラウザズーム変更・デバイス変更に対応）
    self._dpr = window.devicePixelRatio || 1;

    // コンテナ実幅を計測し、指定最大幅 (_initLA_W) 以下に収める
    // → CSS max-width:100% による縮小スケーリングを JS 側で先に吸収し、
    //   canvas 内部ピクセル = 表示 CSS px × DPR を実現して高精細描画する
    var parent = canvas.parentElement;
    var availW = parent ? parent.clientWidth : self._initLA_W;
    var cssW   = availW > 0 ? Math.min(self._initLA_W, availW) : self._initLA_W;
    self._LA_W   = Math.max(1, cssW);
    self._VIEW_W = self._LA_W - self._LABEL_W;

    var n = self._getActiveSigs().length || 1;
    self._laH = (self._showDec && self._cbDec ? self._DEC_LANE_H : 0)
               + n * self._TRACK_H
               + self._MARKER_LANE_H
               + 2 * self._TIME_RULER_H;

    // 物理ピクセル = CSS px × DPR（CSS スケーリングなし → ドット等倍で高精細）
    canvas.width  = Math.round(self._LA_W  * self._dpr);
    canvas.height = Math.round(self._laH   * self._dpr);
    canvas.style.width  = self._LA_W  + 'px';
    canvas.style.height = self._laH   + 'px';

    self._ctx = canvas.getContext('2d');
    self._ctx.setTransform(self._dpr, 0, 0, self._dpr, 0, 0);
    self._lastDrawKey = null;               // canvas の大きさを設定すると中身が消えるので、次は必ず描く
  };

  // ==================== 内部: イベントバインド ====================

  RTLScopeLA.prototype._bindEvents = function() {
    var self = this;

    // ---- ウィンドウリサイズで canvas を再計測・再描画 ----
    // （DevTools 開閉・向き変更・ブラウザズーム変更に対応）
    window.addEventListener('resize', function() {
      self._updateCanvas();
    });

    // ---- 画面の外にあるあいだは描かない（スマホでは LA がゲームの下にあり、ふだん見えない）----
    var laCanvas = document.getElementById(self._canvasId);
    if (laCanvas && typeof IntersectionObserver !== 'undefined') {
      new IntersectionObserver(function(entries) {
        var vis = entries[entries.length - 1].isIntersecting;
        if (vis && self._inView === false) { self._lastDrawKey = null; self._inView = true; self._schedDraw(); }
        self._inView = vis;
      }).observe(laCanvas);
    }

    // ---- ズームボタン ----
    var btnZoomIn  = document.getElementById('la-zoom-in');
    var btnZoomOut = document.getElementById('la-zoom-out');
    var btnZoomLbl = document.getElementById('la-zoom-lbl');
    if (btnZoomIn)  btnZoomIn.addEventListener('click',  function() { self.setZoom(self._zoomIdx + 1); });
    if (btnZoomOut) btnZoomOut.addEventListener('click', function() { self.setZoom(self._zoomIdx - 1); });
    if (btnZoomLbl) btnZoomLbl.addEventListener('click', function() { self.setZoom(2); self._pan = 0; self._panOverride = false; });
    var selZoom = document.getElementById('la-zoom-sel');
    if (selZoom) selZoom.addEventListener('change', function() { self.setZoom(parseInt(this.value, 10)); });

    // ---- ナビゲーションボタン (<< < > >>) ----
    // pan を変更し、_panOverride=true にすることで setFrozen(false) 時もパン位置を維持する。
    // >> のみ _panOverride=false にして live 追従に戻す。
    function _navClampPan(p) {
      var max = Math.max(0, self._lastTotalAvail - self._lastSamplesInView);
      return Math.max(0, Math.min(p, max));
    }
    var btnNavLL = document.getElementById(self._navLL);
    var btnNavL  = document.getElementById(self._navL);
    var btnNavR  = document.getElementById(self._navR);
    var btnNavRR = document.getElementById(self._navRR);
    if (btnNavLL) btnNavLL.addEventListener('click', function() {
      self._pan = Math.max(0, self._lastTotalAvail - self._lastSamplesInView);
      self._panOverride = true;
      self._schedDraw();
    });
    if (btnNavL) btnNavL.addEventListener('click', function() {
      self._pan = _navClampPan(self._pan + self._lastSamplesInView);
      self._panOverride = true;
      self._schedDraw();
    });
    if (btnNavR) btnNavR.addEventListener('click', function() {
      self._pan = Math.max(0, self._pan - self._lastSamplesInView);
      self._panOverride = self._pan > 0;
      self._schedDraw();
    });
    if (btnNavRR) btnNavRR.addEventListener('click', function() {
      self._pan = 0;
      self._panOverride = false;
      self._schedDraw();
    });

    var canvas = document.getElementById(self._canvasId);
    if (!canvas) return;

    // ---- ホイール操作 ----
    // Ctrl+ホイール: ズーム（上 = 拡大、下 = 縮小）
    // ホイール単体 : 水平パン（上 = 過去方向、下 = 現在方向）
    canvas.addEventListener('wheel', function(e) {
      e.preventDefault();
      if (e.ctrlKey) {
        self.setZoom(self._zoomIdx + (e.deltaY > 0 ? -1 : 1));
      } else {
        var step = Math.max(1, Math.round((self._lastSamplesInView || 20) * 0.15));
        self._pan = Math.max(0, self._pan + (e.deltaY > 0 ? -step : step));
      }
      self._schedDraw();
    }, { passive: false });

    // ---- マーカー近傍判定ヘルパー ----
    // lx: canvas 論理座標 X → 'A' | 'B' | 'C' | null
    function _nearMarker(lx, snap) {
      snap = snap || 7;
      var _effLW = self._LABEL_W + (self._valColsW || 0);
      function mxOf(samp) {
        if (samp === null) return null;
        var off = samp - self._lastStartSamp;
        return _effLW - (self._lastSubPx || 0) + off * self._zoom;
      }
      var mxA = mxOf(self._markerA), mxB = mxOf(self._markerB), mxC = mxOf(self._markerC);
      if (mxA !== null && mxA >= _effLW && Math.abs(lx - mxA) <= snap) return 'A';
      if (mxB !== null && mxB >= _effLW && Math.abs(lx - mxB) <= snap) return 'B';
      if (mxC !== null && mxC >= _effLW && Math.abs(lx - mxC) <= snap) return 'C';
      return null;
    }

    // ---- マウスダウン ----
    var laDragX    = null;
    var laDragPan0 = 0;

    canvas.addEventListener('mousedown', function(e) {
      self._tipHide();
      var rect = canvas.getBoundingClientRect();
      var lx   = e.clientX - rect.left;
      var ly   = e.clientY - rect.top;
      // マーカードラッグ判定（波形エリアのみ）
      var _mdEffLW = self._LABEL_W + (self._valColsW || 0);
      if (lx >= _mdEffLW) {
        var near = _nearMarker(lx);
        if (near) { self._markerDrag = near; return; }
      }
      if (lx < self._LABEL_W) {
        var decOff = (self._showDec && self._cbDec) ? self._DEC_LANE_H : 0;
        var sigHd  = self._laH - self._MARKER_LANE_H - 2 * self._TIME_RULER_H - decOff;
        var sigs   = self._getActiveSigs();
        var tHd    = sigs.length > 0 ? sigHd / sigs.length : self._TRACK_H;
        var tidx   = Math.floor((ly - self._TIME_RULER_H - decOff) / tHd);
        if (tidx >= 0 && tidx < sigs.length) {
          self._tDragIdx = tidx;
          self._tDragY   = ly;
        }
      } else if (lx >= _mdEffLW) {
        laDragX    = e.clientX;
        laDragPan0 = self._pan;
      }
    });

    // ---- マウスムーブ ----
    canvas.addEventListener('mousemove', function(e) {
      var rect = canvas.getBoundingClientRect();
      var lx   = e.clientX - rect.left;
      var ly   = e.clientY - rect.top;
      self._tipHover(lx, ly, e.clientX, e.clientY);

      // マーカードラッグ中
      var _mmEffLW = self._LABEL_W + (self._valColsW || 0);
      if (self._markerDrag) {
        var vxM = lx - _mmEffLW + (self._lastSubPx || 0);
        var sampM = self._lastStartSamp + Math.floor(vxM / self._zoom);
        if      (self._markerDrag === 'A') self._markerA = sampM;
        else if (self._markerDrag === 'B') self._markerB = sampM;
        else                               self._markerC = sampM;
        canvas.style.cursor = 'col-resize';
        self._schedDraw();
        return;
      }

      var nearM = lx >= _mmEffLW ? _nearMarker(lx) : null;
      self._cursorViewX = self._tDragIdx !== null ? -1 : Math.max(-1, lx - _mmEffLW);
      canvas.style.cursor = self._tDragIdx !== null ? 'grabbing'
                          : lx < self._LABEL_W      ? 'grab'
                          : lx < _mmEffLW           ? 'default'
                          : nearM                    ? 'col-resize'
                          :                           '';

      if (self._tDragIdx !== null) {
        self._tDragY = ly;
      } else if (laDragX !== null) {
        var dx = e.clientX - laDragX;
        self._pan = Math.max(0, laDragPan0 + dx / self._zoom);
      }
      self._schedDraw();
    });

    // ---- トラックドラッグ確定 ----
    function commitTrackDrag() {
      if (self._tDragIdx === null) return;
      var decOff2 = (self._showDec && self._cbDec) ? self._DEC_LANE_H : 0;
      var sigHc   = self._laH - self._MARKER_LANE_H - 2 * self._TIME_RULER_H - decOff2;
      var sigs    = self._getActiveSigs();
      var tHc     = sigs.length > 0 ? sigHc / sigs.length : self._TRACK_H;
      var insertAt = Math.max(0, Math.min(
        Math.round((self._tDragY - self._TIME_RULER_H - decOff2) / tHc),
        sigs.length
      ));
      var srcIdx = self._tDragIdx;
      self._tDragIdx = null;

      if (insertAt === srcIdx || insertAt === srcIdx + 1) return;

      var srcId    = sigs[srcIdx].id;
      var newOrder = self._sigOrder.filter(function(id) { return id !== srcId; });
      var newActive = newOrder
        .map(function(id) {
          for (var i = 0; i < self._signals.length; i++) {
            if (self._signals[i].id === id) return self._signals[i];
          }
          return null;
        })
        .filter(function(s) { return s && self._sigVisible[s.id]; });
      var effInsert = Math.max(0, Math.min(
        insertAt > srcIdx ? insertAt - 1 : insertAt,
        newActive.length
      ));
      var insertOrderIdx;
      if (effInsert < newActive.length) {
        insertOrderIdx = newOrder.indexOf(newActive[effInsert].id);
      } else {
        insertOrderIdx = newActive.length > 0
          ? newOrder.indexOf(newActive[newActive.length - 1].id) + 1
          : newOrder.length;
      }
      newOrder.splice(insertOrderIdx, 0, srcId);
      self._sigOrder = newOrder;
      localStorage.setItem(self._prefix + 'sig_order', JSON.stringify(self._sigOrder));
      self._updateCanvas();
    }

    // ---- MARKER_LANE クリック: そのマーカーをビュー中央にスクロール ----
    // lx: canvas 論理 x 座標

    // バッジ固定 x（OFF 時や ビュー外のフォールバック位置、_draw の _fixedX と同一）
    function _markerFixedX(idx) { return self._LABEL_W + (self._valColsW || 0) + [14, 36, 58, 88][idx]; }

    // samp が null or ビュー外なら固定バッジ位置を返す
    function _markerDisplayX(samp, fixedX) {
      if (samp === null) return fixedX;
      var _effLW2 = self._LABEL_W + (self._valColsW || 0);
      var mx = _effLW2 - (self._lastSubPx || 0) + (samp - self._lastStartSamp) * self._zoom;
      return (mx >= _effLW2 - 14 && mx <= self._LA_W + 14) ? mx : fixedX;
    }

    // samp をビュー中央になるよう pan を調整する
    function _centerOnSamp(samp) {
      if (samp === null) return;
      var head = self._lastHead >>> 0;
      var sv   = self._lastSamplesInView;
      self._pan = Math.max(0, head - samp - Math.floor(sv / 2));
      self._panOverride = true;
      self._schedDraw();
    }

    function _markerLaneClick(lx) {
      var snap = 20;  // バッジ幅の半分 + 余裕

      // ON 状態のマーカーバッジ付近をクリックしたら中央スクロール
      function tryMarker(samp, isOn, fixedX) {
        if (!isOn) return false;
        var mx = _markerDisplayX(samp, fixedX);
        if (Math.abs(lx - mx) > snap) return false;
        _centerOnSamp(samp);
        return true;
      }

      // TRIG: ON かつ発火済みのとき（TRIG バッジは幅 34px なので snap を拡大）
      function tryTrig() {
        if (!self._trigOn || self._trigHead < 0) return false;
        var trigSamp = (self._trigHead >>> 0);
        var _fxC4 = self._markerFixedXCache || [];
        var trigFx = _fxC4[3] !== null && _fxC4[3] !== undefined
                   ? _fxC4[3] : _markerFixedX(3);
        var mx = _markerDisplayX(trigSamp, trigFx);
        if (Math.abs(lx - mx) > snap + 7) return false;  // halfW=17, snap 余裕 +7
        _centerOnSamp(trigSamp);
        return true;
      }

      // 範囲外バッジは動的配置なのでキャッシュを優先、未初期化時は静的位置にフォールバック
      var _fxC = self._markerFixedXCache || [];
      tryMarker(self._markerA, self._markerAOn, _fxC[0] != null ? _fxC[0] : _markerFixedX(0)) ||
      tryMarker(self._markerB, self._markerBOn, _fxC[1] != null ? _fxC[1] : _markerFixedX(1)) ||
      tryMarker(self._markerC, self._markerCOn, _fxC[2] != null ? _fxC[2] : _markerFixedX(2)) ||
      tryTrig();
    }

    canvas.addEventListener('mouseup', function() {
      self._markerDrag = null;
      commitTrackDrag();
      laDragX = null;
    });
    canvas.addEventListener('mouseleave', function() {
      self._tipHide();
      self._markerDrag = null;
      commitTrackDrag();
      laDragX            = null;
      self._cursorViewX  = -1;
      canvas.style.cursor = '';
    });

    // ---- マウスクリック: MARKER_LANE 内ならトグル ----
    canvas.addEventListener('click', function(e) {
      if (self._markerDrag) return;  // ドラッグ後の click は無視
      var sc = { x: self._LA_W / canvas.getBoundingClientRect().width || 1,
                 y: self._laH  / canvas.getBoundingClientRect().height || 1 };
      var rect = canvas.getBoundingClientRect();
      var lx = (e.clientX - rect.left) * (rect.width  > 0 ? self._LA_W / rect.width  : 1);
      var ly = (e.clientY - rect.top)  * (rect.height > 0 ? self._laH  / rect.height : 1);
      if (ly >= self._laH - self._MARKER_LANE_H) {
        _markerLaneClick(lx);
      }
    });

    // ---- タッチ操作 ----
    // ※ canvas は CSS で max-width:100% によりモバイル幅に縮小されるため、
    //   タッチ座標（CSS px）を canvas 論理座標（canvas px）へ変換してから各判定に使う。
    var laTouch0 = null;

    // CSS 座標 → canvas 論理座標への変換スケールを取得
    function _touchScale() {
      var r = canvas.getBoundingClientRect();
      return {
        x: r.width  > 0 ? self._LA_W / r.width  : 1,
        y: r.height > 0 ? self._laH  / r.height : 1,
        rect: r
      };
    }

    canvas.addEventListener('touchstart', function(e) {
      var sc = _touchScale();
      self._tipHide();                       // どこかに触れたら、出ている説明は消す
      if (e.touches.length === 1) {
        var tx = (e.touches[0].clientX - sc.rect.left) * sc.x;  // canvas logical px
        var ty = (e.touches[0].clientY - sc.rect.top)  * sc.y;
        // 信号名の長押し: TIP_PRESS_MS 動かさなければ説明を出す（動いたら touchmove で取り消す）
        if (self._labelTooltips && tx < self._LABEL_W) {
          var pidx = self._labelLaneAt(ty), px0 = e.touches[0].clientX, py0 = e.touches[0].clientY;
          if (pidx >= 0) {
            self._tipPress = { x: px0, y: py0 };
            self._tipTimer = setTimeout(function() {
              self._tipTimer = null; self._tipPress = null;
              var psig = self._getActiveSigs()[pidx];
              if (psig) { self._tipIdx = pidx; self._tipShow(psig, px0, py0); }
            }, TIP_PRESS_MS);
          }
        }
        // マーカードラッグ判定（タッチは SNAP を広く取る）
        var _tsEffLW = self._LABEL_W + (self._valColsW || 0);
        if (tx >= _tsEffLW) {
          var nearT = _nearMarker(tx, 14);
          if (nearT) {
            self._markerDrag  = nearT;
            self._touchActive = true;
            if (e.cancelable) e.preventDefault();
            return;
          }
        }
        if (tx < self._LABEL_W) {
          // ラベルエリア: 信号名の並び替えドラッグ開始
          var decOff = (self._showDec && self._cbDec) ? self._DEC_LANE_H : 0;
          var sigHd  = self._laH - self._MARKER_LANE_H - 2 * self._TIME_RULER_H - decOff;
          var sigs   = self._getActiveSigs();
          var tHd    = sigs.length > 0 ? sigHd / sigs.length : self._TRACK_H;
          var tidx   = Math.floor((ty - self._TIME_RULER_H - decOff) / tHd);
          if (tidx >= 0 && tidx < sigs.length) {
            self._tDragIdx  = tidx;
            self._tDragY    = ty;   // canvas logical px
            self._touchActive = true;
            laTouch0 = null;
          } else {
            laTouch0 = { x: e.touches[0].clientX, pan: self._pan,
                         dist: null, zoomIdx: self._zoomIdx, scaleX: sc.x,
                         tapCanvasX: tx, tapCanvasY: ty, moved: false };
            self._touchActive = true;
          }
        } else {
          laTouch0 = { x: e.touches[0].clientX, pan: self._pan,
                       dist: null, zoomIdx: self._zoomIdx, scaleX: sc.x,
                       tapCanvasX: tx, tapCanvasY: ty, moved: false };
          self._touchActive = true;
        }
      } else if (e.touches.length === 2) {
        self._tDragIdx = null;
        var tdx = e.touches[0].clientX - e.touches[1].clientX;
        var tdy = e.touches[0].clientY - e.touches[1].clientY;
        laTouch0 = { x: 0, pan: self._pan,
                     dist: Math.sqrt(tdx*tdx + tdy*tdy), zoomIdx: self._zoomIdx, scaleX: sc.x };
        self._touchActive = true;
      }
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchmove', function(e) {
      if (self._tipPress && e.touches.length) {   // 8 px 以上動いたら長押しではなくドラッグ
        var ddx = e.touches[0].clientX - self._tipPress.x, ddy = e.touches[0].clientY - self._tipPress.y;
        if (ddx * ddx + ddy * ddy > 64) { clearTimeout(self._tipTimer); self._tipTimer = null; self._tipPress = null; }
      }
      // マーカードラッグ中
      if (self._markerDrag) {
        if (e.cancelable) e.preventDefault();
        var scMD = _touchScale();
        var txMD = (e.touches[0].clientX - scMD.rect.left) * scMD.x;
        var vxMD = txMD - (self._LABEL_W + (self._valColsW || 0)) + (self._lastSubPx || 0);
        var sampMD = self._lastStartSamp + Math.floor(vxMD / self._zoom);
        if      (self._markerDrag === 'A') self._markerA = sampMD;
        else if (self._markerDrag === 'B') self._markerB = sampMD;
        else                               self._markerC = sampMD;
        self._schedDraw();
        return;
      }
      if (!laTouch0 && self._tDragIdx === null) return;
      if (e.cancelable) e.preventDefault();
      // 移動量でタップ/パンを判別（8px 以上動いたら moved=true）
      if (laTouch0 && !laTouch0.moved && laTouch0.tapCanvasX !== undefined) {
        var _sc2 = _touchScale();
        var _dx = (e.touches[0].clientX - _sc2.rect.left) * _sc2.x - laTouch0.tapCanvasX;
        var _dy = (e.touches[0].clientY - _sc2.rect.top)  * _sc2.y - laTouch0.tapCanvasY;
        if (_dx * _dx + _dy * _dy > 64) laTouch0.moved = true;
      }
      if (self._tDragIdx !== null) {
        // 信号名ドラッグ: canvas 論理 Y を追跡
        var scM = _touchScale();
        self._tDragY = (e.touches[0].clientY - scM.rect.top) * scM.y;
      } else if (e.touches.length === 1 && laTouch0 && laTouch0.dist === null) {
        // パン: CSS delta → canvas 論理 delta → float サンプル数（スムーズスクロール）
        var deltaCanvas = (e.touches[0].clientX - laTouch0.x) * (laTouch0.scaleX || 1);
        self._pan = Math.max(0, laTouch0.pan + deltaCanvas / self._zoom);
      } else if (e.touches.length === 2 && laTouch0 && laTouch0.dist !== null) {
        var tdx2 = e.touches[0].clientX - e.touches[1].clientX;
        var tdy2 = e.touches[0].clientY - e.touches[1].clientY;
        var dist2 = Math.sqrt(tdx2*tdx2 + tdy2*tdy2);
        var newIdx = laTouch0.zoomIdx + Math.round(Math.log2(dist2 / laTouch0.dist));
        self.setZoom(newIdx);
      }
      self._schedDraw();
    }, { passive: false });

    canvas.addEventListener('touchend', function() {
      if (self._tipPress) { clearTimeout(self._tipTimer); self._tipTimer = null; self._tipPress = null; }  // 長押しに満たない
      // マーカードラッグ終了
      if (self._markerDrag) {
        self._markerDrag  = null;
        self._touchActive = false;
        laTouch0 = null;
        return;
      }
      self._touchActive = false;
      commitTrackDrag();
      // MARKER_LANE タップ判定（移動なし & 下部エリア）
      if (laTouch0 && !laTouch0.moved && laTouch0.tapCanvasY !== undefined &&
          laTouch0.tapCanvasY >= self._laH - self._MARKER_LANE_H) {
        _markerLaneClick(laTouch0.tapCanvasX);
      }
      if (!self._frozen) self._pan = 0;  // 実行中は最新データへ戻す
      laTouch0 = null;
    });
  };

  // ==================== 内部: 描画 ====================

  RTLScopeLA.prototype._draw = function(heapu32, head) {
    var self        = this;
    var ctx         = self._ctx;
    var ringSize    = self._ringSize;
    var RW          = self._RW;
    var LA_W        = self._LA_W;
    var LABEL_W     = self._LABEL_W;
    var VIEW_W      = self._VIEW_W;  // この後 EFF_LW 計算後に上書きされる
    var TRACK_H     = self._TRACK_H;
    var TIME_RULER_H  = self._TIME_RULER_H;
    var MARKER_LANE_H = self._MARKER_LANE_H;
    var cbDec       = self._showDec ? self._cbDec : null;
    var cbFmt       = self._cbFmt;
    var cbBg        = self._cbBg;
    var cbTs        = self._cbTs;
    // cbCurExtra は削除（値はラベル右に表示するため不要）
    var laH         = self._laH;
    var laZoom      = self._zoom;

    // ── 値カラム定義 ──
    var VAL_COL_W = 44;
    var hasTrigVC = self._trigOn && self._trigHead >= 0;
    var _valCols = [];
    _valCols.push({label:'Cur',  color:'#664400', bg:'rgba(255,255,160,0.35)', samp:-1});
    if (self._markerAOn && self._markerA !== null)
      _valCols.push({label:'A',    color:'#0064e6', bg:'rgba(0,100,230,0.08)',   samp:(self._markerA >>> 0)});
    if (self._markerBOn && self._markerB !== null)
      _valCols.push({label:'B',    color:'#e07800', bg:'rgba(224,120,0,0.08)',   samp:(self._markerB >>> 0)});
    if (self._markerCOn && self._markerC !== null)
      _valCols.push({label:'C',    color:'#00a050', bg:'rgba(0,160,80,0.08)',    samp:(self._markerC >>> 0)});
    if (hasTrigVC)
      _valCols.push({label:'TRIG', color:'#dc0000', bg:'rgba(220,0,0,0.06)',     samp:(self._trigHead >>> 0)});
    var _valColsW = _valCols.length * VAL_COL_W;
    self._valColsW = _valColsW;
    var EFF_LW = LABEL_W + _valColsW;
    // VIEW_W を値カラム分だけ縮小（波形領域）
    VIEW_W = LA_W - EFF_LW;

    self._lastHead = head;
    ctx.setTransform(self._dpr, 0, 0, self._dpr, 0, 0);

    var sigs  = self._getActiveSigs();
    var decH  = (cbDec) ? self._DEC_LANE_H : 0;
    var sigY  = TIME_RULER_H + decH;                              // 上部: T ルーラー + デコードレーン
    var sigH  = laH - MARKER_LANE_H - 2 * TIME_RULER_H - decH;  // 下部: MARKER_LANE を除く
    var tH    = sigs.length > 0 ? sigH / sigs.length : TRACK_H;

    // ── 背景 ──
    ctx.fillStyle = '#e0e0ea'; ctx.fillRect(0, 0,             LA_W, TIME_RULER_H);   // 上部 T ルーラー
    if (cbDec) {
      ctx.fillStyle = '#e8e8e8'; ctx.fillRect(0, TIME_RULER_H, LA_W, decH);
    }
    ctx.fillStyle = '#f5f5f5'; ctx.fillRect(0, sigY,          LA_W, sigH);
    ctx.fillStyle = '#e0e0ea'; ctx.fillRect(0, sigY + sigH,   LA_W, TIME_RULER_H);   // 下部 T ルーラー
    ctx.fillStyle = '#c8c8d8'; ctx.fillRect(0, laH - MARKER_LANE_H, LA_W, MARKER_LANE_H); // マーカーレーン

    // ── 信号エリア外枠 + ラベル縦区切り ──
    ctx.strokeStyle = '#aaa'; ctx.lineWidth = 1;
    // 波形表示エリアを囲む矩形（EFF_LW より右）
    ctx.strokeRect(EFF_LW + 0.5, sigY + 0.5, VIEW_W - 1, sigH - 1);
    // ラベルエリア | 値カラム の縦区切り（タイムルーラも貫く）
    ctx.beginPath();
    ctx.moveTo(LABEL_W + 0.5, 0); ctx.lineTo(LABEL_W + 0.5, laH);
    ctx.stroke();

    // ── 値カラム背景・縦区切り・ヘッダー ──
    _valCols.forEach(function(vc, ci) {
      var cx = LABEL_W + ci * VAL_COL_W;
      // 背景（信号エリア）
      ctx.fillStyle = vc.bg;
      ctx.fillRect(cx, sigY, VAL_COL_W, sigH);
      // デコードレーン行にも背景を重ねる
      if (cbDec) {
        ctx.fillStyle = vc.bg;
        ctx.fillRect(cx, TIME_RULER_H, VAL_COL_W, decH);
      }
      // 縦区切り線
      ctx.strokeStyle = '#bbc'; ctx.lineWidth = 0.5; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(cx + VAL_COL_W - 0.5, 0); ctx.lineTo(cx + VAL_COL_W - 0.5, laH); ctx.stroke();
      // カラムラベルは非表示（T値のみ表示）
    });
    // EFF_LW の縦区切り（波形との境界）
    if (_valColsW > 0) {
      ctx.strokeStyle = '#aaa'; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(EFF_LW + 0.5, 0); ctx.lineTo(EFF_LW + 0.5, laH); ctx.stroke();
    }

    // ── ズーム / パン計算 ──
    // pan は float（ドット単位スムーズスクロール）で管理する。
    // pan=0（T=0 表示）のときのみ右マージンを設けて T=0 ラベルを見せる。
    var totalAvail    = Math.min(head >>> 0, ringSize);
    var MARGIN_W      = (self._pan === 0) ? Math.round(VIEW_W * 0.10) : 0;
    var DATA_W        = VIEW_W - MARGIN_W;
    var samplesInView = Math.min(Math.ceil(DATA_W / laZoom), ringSize);
    self._pan = Math.max(0, Math.min(self._pan, Math.max(0, totalAvail - samplesInView)));
    var panInt   = Math.floor(self._pan);
    var panFrac  = self._pan - panInt;
    var extraSamp = (panFrac > 0 && totalAvail > panInt + samplesInView) ? 1 : 0;
    // サブピクセルシフト量:
    // extraSamp=1 のとき startSamp が 1 サンプル手前(=laZoom px)にずれるため
    // (1 - panFrac)*laZoom で補正することで連続したスムーズスクロールになる。
    var subPx    = extraSamp * (1 - panFrac) * laZoom;
    var SIG_X    = EFF_LW - subPx;             // 信号描画開始 x（EFF_LW から左にずれる）
    self._lastSubPx = subPx;                  // イベントハンドラ用に保存
    var samples   = Math.min(samplesInView + extraSamp, totalAvail - panInt);
    var startSamp = (head >>> 0) - panInt - samples;
    self._lastStartSamp     = startSamp;
    self._lastSamplesInView = samplesInView;
    self._lastTotalAvail    = totalAvail;

    // 信号ラベル右に表示する値のサンプルオフセット（カーソル優先 → トリガー → 最新）
    var _labelValOff = -1;
    if (samples > 0) {
      if (self._cursorViewX >= 0 && self._cursorViewX <= VIEW_W) {
        _labelValOff = Math.max(0, Math.min(
          Math.floor((self._cursorViewX + subPx) / laZoom), samples - 1));
      } else if (self._trigOn && self._trigHead >= 0) {
        var _toff = ((self._trigHead >>> 0) - startSamp) | 0;
        if (_toff >= 0 && _toff < samples) _labelValOff = _toff;
      }
      if (_labelValOff < 0) _labelValOff = samples - 1;
    }

    // Cursor カラムの samp を確定（_labelValOff に連動）
    if (_labelValOff >= 0) _valCols[0].samp = startSamp + _labelValOff;

    // T ルーラー行の値カラムに T 値を表示（ラベルの下）
    var tBase = (self._trigOn && self._trigHead >= 0)
                ? (self._trigHead >>> 0) : (head >>> 0);
    _valCols.forEach(function(vc, ci) {
      if (vc.samp < 0) return;
      var cx   = LABEL_W + ci * VAL_COL_W;
      var tVal = (vc.samp >>> 0) - tBase;
      var tTxt = tVal === 0 ? '0' : (tVal > 0 ? '+' + tVal : String(tVal));
      ctx.font = '8px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = vc.color;
      ctx.fillText(tTxt, cx + VAL_COL_W / 2, TIME_RULER_H - 2);
    });

    // ── ラベルプレパス（クリップなし）──
    // デコードレーンラベル（ラベルエリア: x < LABEL_W）
    if (cbDec && samples > 0) {
      ctx.fillStyle = '#555'; ctx.font = 'bold 12px monospace'; ctx.textAlign = 'left';
      ctx.fillText(cbDec.label || 'DEC', 2, TIME_RULER_H + decH * 0.72);
      // decode lane の値カラムに Cycle 値を表示
      if (cbDec.getValue) {
        _valCols.forEach(function(vc, ci) {
          if (vc.samp < 0) return;
          var cx = LABEL_W + ci * VAL_COL_W;
          var cvAvail = ((head >>> 0) - (vc.samp >>> 0)) <= (ringSize - 1);
          ctx.font = '9px monospace'; ctx.textAlign = 'center';
          if (!cvAvail) {
            ctx.fillStyle = 'rgba(0,0,0,0.25)';
            ctx.fillText('---', cx + VAL_COL_W / 2, TIME_RULER_H + decH * 0.7);
          } else {
            var cycleVal = cbDec.getValue(heapu32, ringSize, RW, vc.samp >>> 0);
            ctx.fillStyle = cycleVal ? vc.color : 'rgba(0,0,0,0.25)';
            ctx.fillText(cycleVal || '-', cx + VAL_COL_W / 2, TIME_RULER_H + decH * 0.7);
          }
        });
      }
    }
    // 信号名 + トラック区切り線（全幅）
    for (var t = 0; t < sigs.length; t++) {
      var _sig = sigs[t];
      var _yb  = sigY + t * tH;
      ctx.strokeStyle = '#ccc'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(0, _yb + tH); ctx.lineTo(LA_W, _yb + tH); ctx.stroke();
      ctx.fillStyle = '#111'; ctx.font = '12px monospace'; ctx.textAlign = 'left';
      var _lbl = self._numberedLabels
        ? (String(t + 1 + (cbDec ? 1 : 0)).padStart(2, '0') + ' ' + _sig.label) : _sig.label;
      ctx.fillText(_lbl, 3, _yb + tH * 0.65);
      // 値の形式をラベルエリア右寄せで表示
      var _fmtStr = RTLScopeLA.formatName(_sig, cbFmt);
      ctx.font = '8px monospace'; ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillText(_fmtStr, LABEL_W - 2, _yb + tH * 0.88);

      // 値カラムに各信号の値を描画
      _valCols.forEach(function(vc, ci) {
        var cx = LABEL_W + ci * VAL_COL_W;
        var cvSamp = vc.samp;
        var cvAvail = cvSamp >= 0 && ((head >>> 0) - (cvSamp >>> 0)) <= (ringSize - 1);
        ctx.font = '9px monospace'; ctx.textAlign = 'center';
        if (!cvAvail) {
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fillText('---', cx + VAL_COL_W / 2, _yb + tH * 0.7);
          return;
        }
        var _ri  = ((cvSamp >>> 0) & (ringSize - 1)) * RW;
        var _gw  = heapu32[_ri + (_sig.word || 0)];
        var _MASK = _sig.width < 32 ? ((1 << _sig.width) - 1) : 0xFFFFFFFF;
        var _v   = (_gw >> _sig.bit) & _MASK;
        var _vtxt;
        if (_sig.type === 'bit') {
          var _prevSamp = ((cvSamp >>> 0) - 1) >>> 0;
          var _prevAvail = ((head >>> 0) - _prevSamp) <= (ringSize - 1);
          if (_prevAvail) {
            var _pv = (heapu32[(_prevSamp & (ringSize - 1)) * RW + (_sig.word || 0)] >> _sig.bit) & 1;
            if (_pv === 0 && _v === 1)      _vtxt = '↑';  // ↑ Rising
            else if (_pv === 1 && _v === 0) _vtxt = '↓';  // ↓ Falling
            else                            _vtxt = String(_v);
          } else {
            _vtxt = String(_v);
          }
        } else if (_sig.fmt && cbFmt[_sig.fmt]) {
          _vtxt = cbFmt[_sig.fmt](_v);
        } else {
          _vtxt = _v.toString(16).toUpperCase().padStart(_sig.width > 8 ? 4 : 2, '0');
        }
        ctx.fillStyle = vc.color;
        ctx.fillText(_vtxt, cx + VAL_COL_W / 2, _yb + tH * 0.7);
      });
    }

    // MARKER_LANE 区切り線 + 「Marker」固定テキスト（クリップなし）
    var mlaneY = laH - MARKER_LANE_H;
    ctx.strokeStyle = '#aaa'; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(0, mlaneY); ctx.lineTo(LA_W, mlaneY); ctx.stroke();
    ctx.fillStyle = '#666'; ctx.font = '9px monospace'; ctx.textAlign = 'left';
    ctx.fillText('Marker', 2, mlaneY + MARKER_LANE_H - 5);

    // 値カラムのマーカーレーンバッジ
    _valCols.forEach(function(vc, ci) {
      var cx = LABEL_W + ci * VAL_COL_W;
      ctx.fillStyle = vc.color;
      ctx.fillRect(cx + 2, mlaneY + 2, VAL_COL_W - 4, MARKER_LANE_H - 4);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
      ctx.fillText(vc.label, cx + VAL_COL_W / 2, mlaneY + MARKER_LANE_H - 4);
    });

    // ── 信号コンテンツ（クリップ: EFF_LW ～ LA_W）──
    // SIG_X = LABEL_W - subPx でサブピクセル精度のスムーズスクロールを実現する。
    // LABEL_W 左側にはみ出た描画はクリップで自動的に非表示になる。
    ctx.save();
    ctx.beginPath();
    ctx.rect(EFF_LW, 0, VIEW_W, laH);
    ctx.clip();

    // ── デコードレーン描画 ──
    if (cbDec && samples > 0) {
      var decY = TIME_RULER_H;
      cbDec.render(ctx, {
        ctx:        ctx,
        heapu32:    heapu32,
        ringSize:   ringSize,
        ringWords:  RW,
        startSamp:  startSamp,
        samples:    samples,
        laZoom:     laZoom,
        decY:       decY,
        decH:       decH,
        labelW:     EFF_LW,
        sigX:       SIG_X,
        laW:        LA_W
      });
    }

    // ── 各信号波形を描画（ラベルはプレパス済み）──
    if (samples > 0) {
      for (var t = 0; t < sigs.length; t++) {
        var sig   = sigs[t];
        var yBase = sigY + t * tH;
        var MASK  = (sig.width < 32) ? ((1 << sig.width) - 1) : 0xFFFFFFFF;
        var sw    = sig.word || 0;

        if (sig.type === 'bit') {
          var yHigh = yBase + 4, yLow = yBase + tH - 4;

          if (laZoom >= 1) {
            // ── 等倍 / ズームイン ── HIGH スパンを収集してから塗り + 網目
            var _bSpans = [], _bF = null;
            for (var i = 0; i < samples; i++) {
              var gw = heapu32[((startSamp + i) & (ringSize - 1)) * RW + sw];
              var v  = (gw >> sig.bit) & 1, fx = SIG_X + i * laZoom;
              if (v && _bF === null) _bF = fx;
              if (!v && _bF !== null) { _bSpans.push([_bF, fx]); _bF = null; }
            }
            if (_bF !== null) _bSpans.push([_bF, SIG_X + samples * laZoom]);
            // 塗り
            if (self._fillEnabled) {
              ctx.globalAlpha = 0.12; ctx.fillStyle = sig.color;
              for (var _bi = 0; _bi < _bSpans.length; _bi++) {
                ctx.fillRect(_bSpans[_bi][0], yHigh, _bSpans[_bi][1] - _bSpans[_bi][0], yLow - yHigh);
              }
              ctx.globalAlpha = 1;
            }
            // 網目（HIGH スパンをまとめてクリップして描画）
            if (self._hatchEnabled && _bSpans.length > 0 && laZoom >= 2) {
              ctx.save();
              ctx.globalAlpha = 0.18; ctx.strokeStyle = sig.color;
              ctx.lineWidth = 0.7; ctx.setLineDash([]);
              ctx.beginPath();
              for (var _bi = 0; _bi < _bSpans.length; _bi++) {
                ctx.rect(_bSpans[_bi][0], yHigh, _bSpans[_bi][1] - _bSpans[_bi][0], yLow - yHigh);
              }
              ctx.clip();
              _drawHatch(ctx, _bSpans[0][0], _bSpans[_bSpans.length - 1][1],
                         yHigh, yLow, t % 4, 8);
              ctx.restore();
            }
            ctx.strokeStyle = sig.color; ctx.lineWidth = 1.5; ctx.beginPath();
            var gw0b = heapu32[(startSamp & (ringSize - 1)) * RW + sw];
            ctx.moveTo(SIG_X, ((gw0b >> sig.bit) & 1) ? yHigh : yLow);
            for (var i = 0; i < samples; i++) {
              var gw = heapu32[((startSamp + i) & (ringSize - 1)) * RW + sw];
              var v  = (gw >> sig.bit) & 1, x = SIG_X + i * laZoom;
              ctx.lineTo(x, v ? yHigh : yLow); ctx.lineTo(x + laZoom, v ? yHigh : yLow);
            }
            ctx.stroke();

          } else {
            // ── ズームアウト: OR 集約 ──
            var pixCount = Math.ceil(samples * laZoom);
            ctx.globalAlpha = 0.20; ctx.fillStyle = sig.color;
            for (var px = 0; px < pixCount; px++) {
              var si0 = Math.floor(px / laZoom), si1 = Math.min(Math.ceil((px + 1) / laZoom), samples);
              var agg = 0;
              for (var si = si0; si < si1; si++) {
                var gw = heapu32[((startSamp + si) & (ringSize - 1)) * RW + sw];
                agg |= (gw >> sig.bit) & 1;
              }
              if (agg) ctx.fillRect(SIG_X + px, yHigh, 1, yLow - yHigh);
            }
            ctx.globalAlpha = 1;
            ctx.strokeStyle = sig.color; ctx.lineWidth = 1.5; ctx.beginPath();
            var firstPx = true;
            for (var px = 0; px < pixCount; px++) {
              var si0 = Math.floor(px / laZoom), si1 = Math.min(Math.ceil((px + 1) / laZoom), samples);
              var agg = 0;
              for (var si = si0; si < si1; si++) {
                var gw = heapu32[((startSamp + si) & (ringSize - 1)) * RW + sw];
                agg |= (gw >> sig.bit) & 1;
              }
              var xp = SIG_X + px, y = agg ? yHigh : yLow;
              if (firstPx) { ctx.moveTo(xp, y); firstPx = false; } else ctx.lineTo(xp, y);
              ctx.lineTo(xp + 1, y);
            }
            ctx.stroke();
          }

        } else {
          // ── hex 信号 ──
          var hexPad = sig.width > 8 ? 4 : 2;
          var yTop = yBase + 4, yMid = yBase + tH / 2, yBot = yBase + tH - 4;

          // 背景色コールバック
          if (cbBg) {
            if (laZoom >= 1) {
              for (var i = 0; i < samples; i++) {
                var gw  = heapu32[((startSamp + i) & (ringSize - 1)) * RW + sw];
                var val = (gw >> sig.bit) & MASK;
                var bgc = cbBg(sig, val);
                if (bgc) {
                  ctx.fillStyle = bgc;
                  ctx.fillRect(SIG_X + i * laZoom, yBase, laZoom, tH);
                }
              }
            } else {
              var pixC = Math.ceil(samples * laZoom);
              for (var px = 0; px < pixC; px++) {
                var si0 = Math.floor(px / laZoom);
                var gw  = heapu32[((startSamp + si0) & (ringSize - 1)) * RW + sw];
                var val = (gw >> sig.bit) & MASK;
                var bgc = cbBg(sig, val);
                if (bgc) {
                  ctx.fillStyle = bgc;
                  ctx.fillRect(SIG_X + px, yBase, 1, tH);
                }
              }
            }
          }

          // hex セグメント描画
          var gw0h = heapu32[(startSamp & (ringSize - 1)) * RW + sw];
          var pv   = (gw0h >> sig.bit) & MASK, ss = SIG_X, ps = 0, segs = [];
          for (var i = 1; i < samples; i++) {
            var gw = heapu32[((startSamp + i) & (ringSize - 1)) * RW + sw];
            var v  = (gw >> sig.bit) & MASK, xn = SIG_X + i * laZoom;
            if (v !== pv) { segs.push({ x: ss, w: xn - ss, val: pv, s0: ps, s1: i }); ss = xn; ps = i; pv = v; }
          }
          segs.push({ x: ss, w: SIG_X + samples * laZoom - ss, val: pv, s0: ps, s1: samples });
          // 1 px 以下の区間が続く所は、1 つの「変化の多い帯」(busy) にまとめる (1x で毎サンプル変わる値は、ちょうど 1 px)。
          // 画面には 1 px しか出ないので失う物は無く、縮小表示で区間が数千に増えても描く数が増えない
          var _merged = [];
          for (var si = 0; si < segs.length; si++) {
            var sg = segs[si], prev = _merged[_merged.length - 1];
            if (sg.w <= 1 && prev && (prev.busy || prev.w <= 1)) {
              _merged[_merged.length - 1] = { x: prev.x, w: sg.x + sg.w - prev.x, val: null, s0: prev.s0, s1: sg.s1, busy: true };
            } else {
              _merged.push(sg);
            }
          }
          segs = _merged;

          // ── 左端縦棒抑制: view 外にデータがあり値が連続している場合は縦棒なし ──
          var v0h = (gw0h >> sig.bit) & MASK;
          var hasLeftTrans = true;
          if (startSamp > 0) {
            var gwPrevL = heapu32[((startSamp - 1) & (ringSize - 1)) * RW + sw];
            hasLeftTrans = ((gwPrevL >> sig.bit) & MASK) !== v0h;
          }
          // ── 右端縦棒抑制: view 後のサンプルが存在し値が連続している場合は縦棒なし ──
          var nextSampAbsH = startSamp + samples;  // = head - pan
          var hasRightTrans = false;
          if (nextSampAbsH < (head >>> 0)) {
            var vL = (heapu32[((nextSampAbsH - 1) & (ringSize - 1)) * RW + sw] >> sig.bit) & MASK;
            var vN = (heapu32[(nextSampAbsH         & (ringSize - 1)) * RW + sw] >> sig.bit) & MASK;
            hasRightTrans = (vL !== vN);
          }

          // セグメント薄背景（信号枠内 yTop〜yBot）
          if (self._fillEnabled) {
            ctx.save();
            ctx.globalAlpha = 0.08;
            ctx.fillStyle = sig.color;
            for (var si = 0; si < segs.length; si++) {
              if (segs[si].w >= 0.5) ctx.fillRect(segs[si].x, yTop, segs[si].w, yBot - yTop);
            }
            ctx.restore();
          }

          // 網目（全セグメントをまとめてクリップして描画）
          if (self._hatchEnabled) {
            ctx.save();
            ctx.globalAlpha = 0.18; ctx.strokeStyle = sig.color;
            ctx.lineWidth = 0.7; ctx.setLineDash([]);
            ctx.beginPath();
            for (var si = 0; si < segs.length; si++) {
              if (segs[si].w >= 0.5) ctx.rect(segs[si].x, yTop, segs[si].w, yBot - yTop);
            }
            ctx.clip();
            if (segs.length > 0) {
              var _hx0 = segs[0].x, _hx1 = segs[segs.length - 1].x + segs[segs.length - 1].w;
              _drawHatch(ctx, _hx0, _hx1, yTop, yBot, t % 4, 8);
            }
            ctx.restore();
          }

          // 線は種類ごとに 1 本の path に積み、レーンごとに stroke を 1 回にする。
          // 区間ごとに stroke すると、値が毎サンプル変わる信号 (Pong の球の位置など) で 1 画面に数万回になり、
          // 描き替えが 60 fps に間に合わない。区間が細い所は上で busy の帯にまとめてある
          // (1) 値変化点の縦補助線（レーン全体の高さ・薄く）
          ctx.save();
          ctx.strokeStyle = sig.color; ctx.globalAlpha = 0.30; ctx.lineWidth = 0.5;
          ctx.beginPath();
          for (var si = 0; si < segs.length; si++) {
            var s = segs[si];
            if (s.w < 0.5) continue;
            if ((si > 0) || hasLeftTrans)               { ctx.moveTo(s.x, yBase);       ctx.lineTo(s.x, yBase + tH); }
            if ((si < segs.length - 1) || hasRightTrans) { ctx.moveTo(s.x + s.w, yBase); ctx.lineTo(s.x + s.w, yBase + tH); }
          }
          ctx.stroke();
          // (2) busy の帯: 値が 1 px より細かく変わる所は、塗りつぶした帯で示す
          ctx.globalAlpha = 0.45; ctx.fillStyle = sig.color;
          for (var si = 0; si < segs.length; si++) {
            if (segs[si].busy) ctx.fillRect(segs[si].x, yTop, segs[si].w, yBot - yTop);
          }
          ctx.restore();
          // (3) 区間の枠（上下の横線と、値が変わる所の縦線）
          ctx.strokeStyle = sig.color; ctx.lineWidth = 1;
          ctx.beginPath();
          for (var si = 0; si < segs.length; si++) {
            var s = segs[si];
            if (s.w < 0.5) continue;
            ctx.moveTo(s.x, yTop); ctx.lineTo(s.x + s.w, yTop);
            ctx.moveTo(s.x, yBot); ctx.lineTo(s.x + s.w, yBot);
            if ((si > 0) || hasLeftTrans)               { ctx.moveTo(s.x, yTop);       ctx.lineTo(s.x, yBot); }
            if ((si < segs.length - 1) || hasRightTrans) { ctx.moveTo(s.x + s.w, yTop); ctx.lineTo(s.x + s.w, yBot); }
          }
          ctx.stroke();
          // (4) 値の文字（区間が広い所だけ）
          for (var si = 0; si < segs.length; si++) {
            var s = segs[si];
            if (s.w < 0.5 || s.busy) continue;
            // テキスト描画: 文字列・フォントを決定してから白背景 → 文字の順に描く
            var _str = null, _fnt = '11px monospace';
            if (sig.fmt === 'dec') {
              if (laZoom >= 4 && s.w > 4) { _str = String(s.val); }
            } else if ((laZoom >= 4 && s.w > 4) || s.w > 24) {
              if (sig.fmt && cbFmt[sig.fmt]) {
                _fnt = '10px monospace';
                _str = cbFmt[sig.fmt](s.val, sig, {
                  heapu32: heapu32, ringWords: RW, ringSize: ringSize,
                  startSamp: startSamp, s0: s.s0, s1: s.s1
                });
              } else {
                var _fullLbl  = s.val.toString(16).toUpperCase().padStart(hexPad, '0');
                var _shortLbl = s.val.toString(16).toUpperCase();
                var _fullThresh = hexPad === 4 ? 40 : 28;
                _str = s.w > _fullThresh ? _fullLbl : _shortLbl;
              }
            }
            if (_str !== null) {
              ctx.font = _fnt; ctx.textAlign = 'center';
              var _tx = s.x + s.w / 2;
              var _tw = ctx.measureText(_str).width;
              // 数字部分の白背景
              ctx.fillStyle = 'rgba(255,255,255,0.85)';
              ctx.fillRect(_tx - _tw / 2 - 2, yMid - 6, _tw + 4, 14);
              // 文字
              ctx.fillStyle = sig.color;
              ctx.fillText(_str, _tx, yMid + 4);
            }
          }
        }
      } // end signal loop
    }

    // ── 1T 補助線（点線）: laZoom >= 4 のとき全サンプルに描画 ──
    if (samples > 0 && laZoom >= 4) {
      ctx.save();
      ctx.strokeStyle = 'rgba(80,80,200,0.12)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      for (var gi = 0; gi < samples; gi++) {
        var gx = SIG_X + gi * laZoom;
        ctx.moveTo(gx, sigY); ctx.lineTo(gx, sigY + sigH);
      }
      ctx.stroke();
      ctx.restore();
    }
    // ── T1（マシンサイクル境界）実線 ──
    if (cbTs && samples > 0 && laZoom >= 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(80,80,200,0.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (var gi = 0; gi < samples; gi++) {
        var gw0g = heapu32[((startSamp + gi) & (ringSize - 1)) * RW];
        if (cbTs(gw0g) === 1) {
          var gx = SIG_X + gi * laZoom;
          ctx.moveTo(gx, sigY); ctx.lineTo(gx, sigY + sigH);
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    // ── MARKER_LANE バッジ + マーカー縦線 ──
    // ON のときのみバッジを表示（OFF のときは Marker レーンに表示しない）
    // [3] は Trig 用固定位置。A/B/C の固定位置は後で動的計算する。
    var _fixedX = [0, 0, 0, EFF_LW + 88];  // [3] は Trig 用フォールバック（実際は動的配置で上書き）
    function drawMarker(mLabel, mSamp, isOn, mLineColor, mBadgeColor, fixedX) {
      if (!isOn) return;  // OFF のときはバッジ非表示
      var hasSamp = mSamp !== null;
      var off     = hasSamp ? mSamp - startSamp : null;
      var mx      = hasSamp ? SIG_X + off * laZoom : fixedX;
      var inView  = hasSamp && off >= 0 && off < samples;
      var showAtPos = hasSamp && mx >= SIG_X - 12 && mx <= LA_W + 12;

      // 縦線・バッジとも信号領域（x >= LABEL_W）のみに表示
      ctx.save();
      ctx.beginPath();
      ctx.rect(EFF_LW, 0, LA_W - EFF_LW, laH);
      ctx.clip();

      // ── 縦線: 範囲外は端にクランプして常に表示 ──
      if (hasSamp) {
        var lineX = inView ? mx
                  : (mx < EFF_LW ? EFF_LW      // 左（過去）はみ出し → 左端
                                 : LA_W - 1);  // 右（未来）はみ出し → 右端
        ctx.strokeStyle = mLineColor;
        ctx.lineWidth   = inView ? 2.5 : 1.5;
        ctx.setLineDash(inView ? [6, 4] : [2, 5]);
        ctx.globalAlpha = inView ? 1.0 : 0.45;
        ctx.beginPath(); ctx.moveTo(lineX, 0); ctx.lineTo(lineX, mlaneY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1.0;
      }

      // ── バッジ: ビュー内ならその位置 / ビュー外なら固定位置 ──
      var bx = showAtPos ? mx : fixedX;
      var BW = 20, BH = MARKER_LANE_H;
      ctx.fillStyle = mBadgeColor;
      ctx.fillRect(bx - BW / 2, mlaneY, BW, BH);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(mLabel, bx, mlaneY + BH - 4);
      ctx.restore();
    }
    // A-B 差分: ハイライト + T ステート数ラベル
    if (self._markerAOn && self._markerBOn && self._markerA !== null && self._markerB !== null) {
      var diff = Math.abs(self._markerA - self._markerB);
      var offA = self._markerA - startSamp, offB = self._markerB - startSamp;
      var xL = SIG_X + Math.max(0, Math.min(offA, offB)) * laZoom;
      var xR = SIG_X + Math.min(samples, Math.max(offA, offB)) * laZoom;
      if (xR > xL && xR > EFF_LW && xL < LA_W) {
        ctx.fillStyle = 'rgba(120,120,255,0.07)';
        ctx.fillRect(xL, sigY, xR - xL, sigH);
      }
      var diffT   = Math.round(diff / 2);
      var diffStr = 'A-B: ' + diffT + ' T';
      ctx.font = '11px monospace'; ctx.textAlign = 'left';
      var dw = ctx.measureText(diffStr).width;
      ctx.fillStyle = 'rgba(215,215,245,0.93)';
      ctx.fillRect(EFF_LW + 2, sigY + sigH - 15, dw + 6, 14);
      ctx.fillStyle = '#224'; ctx.fillText(diffStr, EFF_LW + 5, sigY + sigH - 4);
    }

    // ── トラックドラッグ ビジュアル ──
    if (self._tDragIdx !== null && self._tDragIdx < sigs.length) {
      ctx.fillStyle = 'rgba(60,100,255,0.12)';
      ctx.fillRect(0, sigY + self._tDragIdx * tH, LA_W, tH);
      ctx.fillStyle = 'rgba(40,80,220,0.9)';
      ctx.font = 'bold 12px monospace'; ctx.textAlign = 'left';
      var _dlbl = self._numberedLabels
        ? (String(self._tDragIdx + 1 + (cbDec ? 1 : 0)).padStart(2, '0') + ' ' + sigs[self._tDragIdx].label)
        : sigs[self._tDragIdx].label;
      ctx.fillText(_dlbl, 3, sigY + self._tDragIdx * tH + tH * 0.65);
      var insertAt = Math.max(0, Math.min(Math.round((self._tDragY - sigY) / tH), sigs.length));
      var iy = sigY + insertAt * tH;
      ctx.save();
      ctx.strokeStyle = 'rgba(40,80,220,0.85)'; ctx.lineWidth = 2; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(EFF_LW, iy); ctx.lineTo(LA_W, iy); ctx.stroke();
      ctx.fillStyle = 'rgba(40,80,220,0.85)';
      ctx.beginPath();
      ctx.moveTo(EFF_LW, iy); ctx.lineTo(EFF_LW + 8, iy - 4); ctx.lineTo(EFF_LW + 8, iy + 4);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // TRIG 描画はクリップ解除後の統合 IIFE に移動

    // ── クロックルーラー（クリップ内: tick はサブピクセルシフト済み）──
    if (samples > 0) {
      // 1T 細目盛り（laZoom >= 4 のとき全サンプルに短い tick を表示）
      if (laZoom >= 4) {
        ctx.strokeStyle = '#ccc'; ctx.lineWidth = 0.5;
        for (var fi = 0; fi < samples; fi++) {
          var fx = SIG_X + fi * laZoom;
          ctx.beginPath();
          ctx.moveTo(fx, 0);           ctx.lineTo(fx, 3);           // 上部ルーラー
          ctx.moveTo(fx, sigY + sigH); ctx.lineTo(fx, sigY + sigH + 3); // 下部ルーラー
          ctx.stroke();
        }
      }

      var NICE = [1, 2, 4, 10, 20, 40, 100, 200, 400, 1000, 2000, 4000, 8000];
      var rawSamp  = (laZoom >= 16) ? 1 : (80 / laZoom);
      var tickSamp = NICE[NICE.length - 1];
      for (var ni = 0; ni < NICE.length; ni++) {
        if (NICE[ni] >= rawSamp) { tickSamp = NICE[ni]; break; }
      }
      var firstTick = Math.ceil(startSamp / tickSamp) * tickSamp;

      ctx.strokeStyle = '#999'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(EFF_LW, sigY);        ctx.lineTo(LA_W, sigY);        ctx.stroke();
      ctx.beginPath(); ctx.moveTo(EFF_LW, sigY + sigH); ctx.lineTo(LA_W, sigY + sigH); ctx.stroke();

      ctx.font = '10px monospace'; ctx.textAlign = 'center';

      // T=0 の基準: トリガー発火時は TRIG マーカー位置、未発火時はヘッド
      var tBase = (self._trigOn && self._trigHead >= 0)
                  ? (self._trigHead >>> 0)       // TRIG マーカーを T=0
                  : (head >>> 0);                // ヘッドを T=0（デフォルト）

      for (var tick = firstTick; ; tick += tickSamp) {
        var toff = tick - startSamp;
        var tx2  = SIG_X + toff * laZoom;
        if (tx2 >= LA_W - 1) break;  // キャンバス右端を超えたら終了
        // LABEL_W 左側はクリップで自動非表示（tx2 < LABEL_W の continue 不要）
        var tNum = tick - tBase;
        var lbl2 = (tNum === 0 ? '0' : (tNum > 0 ? '+' + tNum : '' + tNum));

        ctx.strokeStyle = '#888'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(tx2, 0); ctx.lineTo(tx2, 5); ctx.stroke();
        ctx.fillStyle = '#444'; ctx.fillText(lbl2, tx2, 12);

        ctx.beginPath(); ctx.moveTo(tx2, sigY); ctx.lineTo(tx2, sigY + 5); ctx.stroke();

        ctx.beginPath(); ctx.moveTo(tx2, sigY + sigH); ctx.lineTo(tx2, sigY + sigH + 5); ctx.stroke();
        ctx.fillStyle = '#444'; ctx.fillText(lbl2, tx2, sigY + sigH + 11);
      }
    }

    // ── クリップ解除 ──
    ctx.restore();

    // ── マーカー縦線 + バッジ（クリップなし: A/B/C/TRIG 統合動的配置）──
    // 左寄せ / 右寄せ、samp 昇順ソート、バッジ幅考慮の重なり防止
    (function() {
      var GAP = 2;
      var hasTrig  = self._trigHead >= 0 && self._trigOn;
      var trigSamp = hasTrig ? (self._trigHead >>> 0) : null;

      // 各マーカー定義（halfW: バッジ半幅）
      var _mkrs = [
        { idx:0, label:'A', samp:self._markerA, on:self._markerAOn, halfW:10,
          lc:'rgba(0,100,230,0.85)', bc:'#0064e6' },
        { idx:1, label:'B', samp:self._markerB, on:self._markerBOn, halfW:10,
          lc:'rgba(224,120,0,0.85)', bc:'#e07800' },
        { idx:2, label:'C', samp:self._markerC, on:self._markerCOn, halfW:10,
          lc:'rgba(0,160,80,0.85)',  bc:'#00a050' },
        { idx:3, label:'TRIG', samp:trigSamp,   on:hasTrig,         halfW:17 },
      ];

      // ビュー内 / 左範囲外 / 右範囲外 を分類
      var leftOut = [], rightOut = [];
      _mkrs.forEach(function(m) {
        if (!m.on || m.samp === null) return;
        var off = m.samp - startSamp;
        var mx  = SIG_X + off * laZoom;
        m._mx       = mx;
        m._inView   = off >= 0 && off < samples;
        m._showAtPos = mx >= SIG_X - (m.halfW + 2) && mx <= LA_W + (m.halfW + 2);
        if (!m._showAtPos) {
          if (mx < EFF_LW) leftOut.push(m);
          else             rightOut.push(m);
        }
      });

      // 左寄せ: samp 昇順（古い順）で EFF_LW の右端から右へ、幅を考慮して並べる
      leftOut.sort(function(a, b) { return a.samp - b.samp; });
      var lCursor = EFF_LW;
      leftOut.forEach(function(m) {
        lCursor   += m.halfW;
        m._fixedX  = lCursor;
        lCursor   += m.halfW + GAP;
      });

      // 右寄せ: samp 昇順（最大 samp が最右端）、右端から逆順に配置
      rightOut.sort(function(a, b) { return a.samp - b.samp; });
      var rCursor = LA_W;
      for (var ri = rightOut.length - 1; ri >= 0; ri--) {
        rCursor          -= rightOut[ri].halfW;
        rightOut[ri]._fixedX = rCursor;
        rCursor          -= rightOut[ri].halfW + GAP;
      }

      // クリックハンドラー用キャッシュ更新（A/B/C は idx 0-2、TRIG は idx 3）
      var cache = [null, null, null, null];
      _mkrs.forEach(function(m) { cache[m.idx] = m._fixedX || null; });
      self._markerFixedXCache = cache;

      // ── 描画 ──
      _mkrs.forEach(function(m) {
        if (!m.on || m.samp === null) return;
        var fxFallback = m._mx < EFF_LW ? EFF_LW + m.halfW : LA_W - m.halfW;
        var fixedX = m._fixedX !== undefined ? m._fixedX : fxFallback;

        if (m.idx < 3) {
          // A / B / C: 既存 drawMarker を使用
          drawMarker(m.label, m.samp, m.on, m.lc, m.bc, fixedX);
        } else {
          // TRIG: 専用描画（バッジ幅 34px）
          var TBW = m.halfW * 2, TBH = MARKER_LANE_H;
          var fireX = m._showAtPos ? m._mx : fixedX;
          var lineX = m._inView  ? m._mx
                    : (m._mx < EFF_LW ? EFF_LW : LA_W - 1);
          ctx.save();
          ctx.beginPath();
          ctx.rect(EFF_LW, 0, LA_W - EFF_LW, laH);
          ctx.clip();
          // 縦線
          ctx.strokeStyle = 'rgba(220,0,0,0.85)';
          ctx.lineWidth   = m._inView ? 2.5 : 1.5;
          ctx.setLineDash(m._inView ? [3, 6] : [2, 5]);
          ctx.globalAlpha = m._inView ? 1.0 : 0.45;
          ctx.beginPath(); ctx.moveTo(lineX, 0); ctx.lineTo(lineX, mlaneY); ctx.stroke();
          ctx.setLineDash([]); ctx.globalAlpha = 1.0;
          // バッジ
          ctx.fillStyle = '#dc0000';
          ctx.fillRect(fireX - TBW / 2, mlaneY, TBW, TBH);
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
          ctx.fillText('TRIG', fireX, mlaneY + TBH - 4);
          ctx.restore();
        }
      });
    })();

    // ── カーソル（縦破線のみ）──
    if (self._cursorViewX >= 0 && self._cursorViewX <= VIEW_W && samples > 0) {
      var cursorX = EFF_LW + self._cursorViewX;
      ctx.save();
      ctx.strokeStyle = 'rgba(200,80,0,0.8)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(cursorX, sigY); ctx.lineTo(cursorX, sigY + sigH); ctx.stroke();
      ctx.restore();
    }

    // ── クロックルーラー T ラベル（ラベルエリア x=2、クリップなし）──
    if (samples > 0) {
      ctx.fillStyle = '#888'; ctx.font = '10px monospace'; ctx.textAlign = 'left';
      ctx.fillText('T', 2, 11);
      ctx.fillText('T', 2, sigY + sigH + 11);
    }

    // ── 右端縦線（タイムルーラーを含むキャンバス全高 — 最後に重ねて確実に表示）──
    // LA_W - 0.5 だと DPR×2 時に右半ピクセルがクリップされるため LA_W - 1 に配置
    ctx.strokeStyle = '#999'; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(LA_W - 1, 0);
    ctx.lineTo(LA_W - 1, laH);
    ctx.stroke();
  };

  // ==================== エクスポート ====================

  RTLScopeLA.VERSION = VERSION;
  RTLScopeLA.pickLang    = _pickLang;
  RTLScopeLA.tr          = _tr;
  RTLScopeLA.laneIndex   = _laneIndex;
  RTLScopeLA.formatName  = _formatName;
  RTLScopeLA.tipContent  = _tipContent;
  global.RTLScopeLA = RTLScopeLA;

})(window);
