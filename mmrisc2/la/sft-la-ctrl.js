// 元: soft-FPGA (https://github.com/tommie-jp/soft-fpga) の js/sft-la-ctrl.js (soft-FPGA f59a45c、2026-10-17)。手を入れずに写した
// sft-la-ctrl.js — 汎用 Logic Analyzer コントロール（CPU 非依存）
//
// Freeze/Thaw・エッジ/値トリガー・LA ON/OFF・Fill/Hatch をまとめて配線する。
// 具体的なシミュレータ呼び出しは backend に注入する（Wasm 直呼びでも Worker 経由でも可）。
//
//   const ctrl = initLaCtrl({
//     la,                    // RTLScopeLA インスタンス
//     signals,               // LA 信号定義配列（トリガー対象の選択肢）
//     backend: {
//       freeze(), thaw(), isFrozen(),
//       setLA(on), setPostDelay(n), clearTrigger(),
//       setEdgeTrigger(word, bit, dir),          // dir: 0=立ち上がり 1=立ち下がり
//       setValueTrigger(word, mask, cmp),
//     },
//     onArm(),               // トリガー設定後（実行を再開したいとき）に呼ばれる
//     storagePrefix,         // localStorage キー接頭辞
//     triggerPresets,        // トリガーのプリセット (省略可。sft-trigger-presets.js が要る)
//                            //   [{ label, tip, sig: 信号の id, mode: 'eq'|'rise'|'fall', value, post }, ...]
//     onPreset(preset, restored),   // プリセットを欄に入れた後に呼ぶ (省略可。記録モードの切り替えなど)
//   });
//   ctrl.sync(frozen);       // 毎フレーム呼ぶ: Freeze ボタン表示を実状態に合わせる
//
// 必要な DOM id: btn-la-toggle, la-fill-chk, la-hatch-chk, btn-freeze,
//   btn-trig-toggle, trig-detail, trig-sig, trig-mode, trig-val, trig-post,
//   btn-trig-set, btn-trig-clear, btn-goto-trig, trig-msg

function initLaCtrl(opts) {
  'use strict';
  var la      = opts.la;
  var backend = opts.backend;
  var prefix  = opts.storagePrefix || 'la_';
  var sigs    = opts.signals || [];

  function need(id) {
    var el = document.getElementById(id);
    if (!el) throw new Error('initLaCtrl: #' + id + ' が見つかりません');
    return el;
  }

  function lsGet(key) {
    try { return localStorage.getItem(key); }
    catch (e) { console.warn('[la-ctrl] localStorage 読み取り失敗:', e); return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, val); }
    catch (e) { console.warn('[la-ctrl] localStorage 書き込み失敗:', e); }
  }

  var btnFreeze = need('btn-freeze');
  var btnLa     = need('btn-la-toggle');
  var msg       = need('trig-msg');
  var selSig    = need('trig-sig');
  var selMode   = need('trig-mode');
  var inVal     = need('trig-val');
  var inPost    = need('trig-post');

  function showMsg(text, isError) {
    msg.textContent = text;
    msg.style.color = isError ? '#cc3333' : '#555';
  }

  // ---- Hold / Resume (内部の名前は freeze / thaw のまま) ----
  var FREEZE_LABEL = '⏸ Hold';
  var THAW_LABEL   = '▶ Resume';
  function syncFreeze(frozen) {
    var want = frozen ? THAW_LABEL : FREEZE_LABEL;
    if (btnFreeze.textContent !== want) btnFreeze.textContent = want;
  }
  btnFreeze.addEventListener('click', function() {
    if (backend.isFrozen()) backend.thaw(); else backend.freeze();
    syncFreeze(backend.isFrozen());
  });

  // ---- LA ON/OFF ----
  btnLa.addEventListener('click', function() {
    la.setEnabled(!la.enabled);
    btnLa.textContent = la.enabled ? 'LA ON' : 'LA OFF';
    btnLa.style.color = la.enabled ? '' : '#cc3333';
    backend.setLA(la.enabled);
    if (!la.enabled) la._drawOff();
  });

  // ---- Fill / Hatch ----
  need('la-fill-chk').addEventListener('change', function() {
    la.setFillEnabled(this.checked);
    la._updateCanvas();
  });
  need('la-hatch-chk').addEventListener('change', function() {
    la.setHatchEnabled(this.checked);
    la._updateCanvas();
  });

  // ---- Trigger パネルの折りたたみ ----
  var toggleBtn = need('btn-trig-toggle');
  var detail    = need('trig-detail');
  var openKey   = prefix + 'trig_open';
  var isOpen    = lsGet(openKey) === '1';
  function applyPanel() {
    detail.style.display  = isOpen ? 'flex' : 'none';
    toggleBtn.textContent = '⚙ Trigger ' + (isOpen ? '▾' : '▸');
  }
  applyPanel();
  toggleBtn.addEventListener('click', function() {
    isOpen = !isOpen;
    lsSet(openKey, isOpen ? '1' : '0');
    applyPanel();
  });

  // ---- トリガー対象の信号選択 ----
  // 同じ (word, bit, width) の別表示（count と count10 など）は先頭だけ選択肢にする。
  var seen = {};
  var trigSigs = [];
  sigs.forEach(function(s) {
    var key = (s.word || 0) + ':' + s.bit + ':' + s.width;
    if (seen[key]) return;
    seen[key] = true;
    trigSigs.push(s);
  });
  trigSigs.forEach(function(s, i) {
    var o = document.createElement('option');
    o.value = s.id;                // プリセット (triggerPresets) が信号を id で指せるように
    o.textContent = s.label + (s.width > 1 ? '[' + (s.bit + s.width - 1) + ':' + s.bit + ']' : '');
    selSig.appendChild(o);
  });

  function curSig() {
    for (var i = 0; i < trigSigs.length; i++) if (trigSigs[i].id === selSig.value) return trigSigs[i];
    return undefined;
  }

  // 1 ビット信号のみ rise/fall を許可。複数ビットは == のみ。
  function syncModeOptions() {
    var s = curSig();
    var isBit = s && s.width === 1;
    Array.prototype.forEach.call(selMode.options, function(o) {
      o.disabled = (o.value === 'rise' || o.value === 'fall') && !isBit;
    });
    if (selMode.options[selMode.selectedIndex].disabled) selMode.value = 'eq';
    var needVal = selMode.value === 'eq';
    inVal.style.display = needVal ? '' : 'none';
    inVal.placeholder   = (s && s.width === 1) ? '0 / 1' : 'value (hex)';
  }
  selSig.addEventListener('change', syncModeOptions);
  selMode.addEventListener('change', syncModeOptions);
  syncModeOptions();

  // ---- トリガー設定 ----
  function parseValue(s, text) {
    var t = text.trim().replace(/^0x/i, '');
    if (t === '') throw new Error('比較値を入力してください');
    var v = (s.width === 1) ? parseInt(t, 2) : parseInt(t, 16);
    if (!/^[0-9a-f]+$/i.test(t) || isNaN(v)) throw new Error('比較値が不正です: ' + text);
    var max = s.width >= 32 ? 0xFFFFFFFF : (1 << s.width) - 1;
    if (v > max) throw new Error('比較値が範囲外です（最大 0x' + max.toString(16).toUpperCase() + '）');
    return v;
  }

  need('btn-trig-set').addEventListener('click', function() {
    try {
      var s    = curSig();
      var mode = selMode.value;
      var post = inPost.value.trim() === '' ? 0 : parseInt(inPost.value, 10);
      if (isNaN(post) || post < 0) throw new Error('post は 0 以上の整数（クロック数）で指定してください');
      backend.setPostDelay(post);

      var word = s.word || 0;
      if (mode === 'rise' || mode === 'fall') {
        backend.setEdgeTrigger(word, s.bit, mode === 'fall' ? 1 : 0);
        showMsg(s.label + (mode === 'fall' ? ' 立ち下がり' : ' 立ち上がり') + ' で停止します');
      } else {
        var v    = parseValue(s, inVal.value);
        var mask = (s.width >= 32 ? 0xFFFFFFFF : ((1 << s.width) - 1)) << s.bit;
        backend.setValueTrigger(word, mask | 0, (v << s.bit) | 0);
        showMsg(s.label + ' == 0x' + v.toString(16).toUpperCase() + ' で停止します');
      }
      la.setTrigFireHead(-1);
      syncFreeze(false);
      if (opts.onArm) opts.onArm();
    } catch (e) {
      console.error('[la-ctrl] トリガー設定エラー:', e);
      showMsg(e.message, true);
    }
  });

  need('btn-trig-clear').addEventListener('click', function() {
    backend.clearTrigger();
    la.setTrigFireHead(-1);
    syncFreeze(false);
    showMsg('トリガーを解除しました');
  });

  need('btn-goto-trig').addEventListener('click', function() {
    la.gotoTrig();
  });

  // ---- トリガーのプリセット (典型的な設定) ----
  var presets = opts.triggerPresets || [];
  if (presets.length && typeof mountTriggerPresets !== 'function') {
    console.warn('[la-ctrl] triggerPresets があるが sft-trigger-presets.js が読み込まれていません');
  } else if (presets.length) {
    mountTriggerPresets({
      host: detail,
      storageKey: prefix + 'trig_theme',
      presets: presets.map(function (p) {
        if (!trigSigs.some(function (s) { return s.id === p.sig; }))
          console.warn('[la-ctrl] プリセット「' + p.label + '」の信号 ' + p.sig + ' がトリガーの選択肢にありません');
        var f = { 'trig-sig': p.sig, 'trig-mode': p.mode || 'eq' };
        if (p.value !== undefined) f['trig-val'] = p.value;
        f['trig-post'] = p.post !== undefined ? p.post : 0;
        return Object.assign({}, p, { fields: f });
      }),
      onApply: function (p, restored) {
        showMsg('プリセット「' + p.label + '」を入れました。Set で設定します');
        if (opts.onPreset) opts.onPreset(p, restored);
      }
    });
  }

  return { sync: syncFreeze };
}
