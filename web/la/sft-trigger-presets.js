// 元: soft-FPGA (https://github.com/tommie-jp/soft-fpga) の js/sft-trigger-presets.js (soft-FPGA f59a45c、2026-10-17)。手を入れずに写した
// sft-trigger-presets.js — トリガーの「プリセット」(典型的な設定) をドロップダウンから選ぶ部品
//
// プリセットを選ぶと、トリガーのフォームの各欄に値を入れる。Set は押さない (入った値を見てから Set する)。
// フォームの作りは例ごとに違う (共通 LA・06-8080・09-PDP11) ので、プリセットは「欄の id → 値」の組で書く。
//
//   mountTriggerPresets({
//     host:       document.getElementById('trig-detail'),  // この要素の先頭にドロップダウンを置く
//     before:     null,                // 置く位置を変えたいとき、この子要素の前に置く (省略可)
//     presets:    [{ label: 'ヒット', tip: '説明', fields: { 'trig-sig': 'snd_kind', 'trig-val': '1' } }, ...],
//     storageKey: 'pong_la_trig_theme',// 最後に選んだプリセットを覚える localStorage のキー (省略可)
//     onApply:    function (preset, restored) {},   // 欄に入れた後に呼ぶ (省略可。restored = 起動時の復元)
//     text:       { label: 'Preset', manual: '(manual)', tip: '...' },   // 文言 (省略可。英語の UI 向け)
//   });
//
// - fields は書いた順に入れ、欄ごとに 'change' を送る (種類の欄を先に書くと、その欄に応じた表示の切り替えが先に済む)
// - 人がフォームを触ったら、プリセットの表示を「(手で指定)」に戻す
// - 欄が無い、またはドロップダウンに無い値のときは console.warn で言い、その欄は飛ばす

function mountTriggerPresets(opts) {
  'use strict';
  var presets = opts.presets || [];
  var host    = opts.host;
  if (!host || presets.length === 0) return null;

  var text = Object.assign({
    label:  'プリセット',
    manual: '(手で指定)',
    tip:    '典型的なトリガーの設定を選ぶと、欄に値が入ります。Set で設定します。'
  }, opts.text || {});
  var MANUAL = '';
  var wrap = document.createElement('label');
  wrap.className = 'trig-theme';
  wrap.title = text.tip;
  wrap.appendChild(document.createTextNode(text.label + ' '));
  var sel = document.createElement('select');
  sel.id = 'trig-theme';
  var o0 = document.createElement('option');
  o0.value = MANUAL;
  o0.textContent = text.manual;
  sel.appendChild(o0);
  presets.forEach(function (p, i) {
    var o = document.createElement('option');
    o.value = String(i);
    o.textContent = p.label;
    if (p.tip) o.title = p.tip;
    sel.appendChild(o);
  });
  wrap.appendChild(sel);
  host.insertBefore(wrap, opts.before || host.firstChild);

  function lsGet() {
    if (!opts.storageKey) return null;
    try { return localStorage.getItem(opts.storageKey); }
    catch (e) { console.warn('[trig-theme] localStorage 読み取り失敗:', e); return null; }
  }
  function lsSet(v) {
    if (!opts.storageKey) return;
    try { localStorage.setItem(opts.storageKey, v); }
    catch (e) { console.warn('[trig-theme] localStorage 書き込み失敗:', e); }
  }

  var applied = {};   // いまのプリセットで入れた値 (欄の id → 値)。手で触ったかの判定に使う

  function setField(id, value) {
    var el = document.getElementById(id);
    if (!el) { console.warn('[trig-theme] 欄 #' + id + ' が見つかりません'); return; }
    var v = String(value);
    if (el.tagName === 'SELECT' &&
        !Array.prototype.some.call(el.options, function (o) { return o.value === v; })) {
      console.warn('[trig-theme] #' + id + ' に値 "' + v + '" の選択肢がありません');
      return;
    }
    el.value = v;
    applied[id] = v;
    el.dispatchEvent(new Event('change'));   // bubbles: false なので、下の「手で触った」の検出には届かない
  }

  function apply(idx, restored) {
    var p = presets[idx];
    if (!p) return;
    applied = {};
    Object.keys(p.fields || {}).forEach(function (id) { setField(id, p.fields[id]); });
    sel.value = String(idx);
    sel.title = p.tip || '';
    if (opts.onApply) opts.onApply(p, !!restored);
  }

  sel.addEventListener('change', function () {
    if (sel.value === MANUAL) { lsSet(''); sel.title = ''; return; }
    var i = parseInt(sel.value, 10);
    lsSet(presets[i].label);
    apply(i, false);
  });

  // 人がフォームを触ったら「(手で指定)」に戻す (プリセットを入れたときの change は bubbles: false で、ここに来ない)。
  // 値がプリセットで入れたままなら触っていないと見なす (手で書いていた欄からフォーカスが外れると、遅れて change が来るため)
  function onManual(e) {
    if (e.target === sel || sel.value === MANUAL) return;
    var id = e.target && e.target.id;
    if (id && Object.prototype.hasOwnProperty.call(applied, id) && e.target.value === applied[id]) return;
    sel.value = MANUAL;
    sel.title = '';
    lsSet('');
  }
  host.addEventListener('input', onManual);
  host.addEventListener('change', onManual);

  // 起動時: 前に選んだプリセットを (ラベルで探して) 欄に入れ直す。Set はしない
  var saved = lsGet();
  if (saved) {
    var j = presets.findIndex(function (p) { return p.label === saved; });
    if (j >= 0) apply(j, true);
  }

  return { select: sel, apply: function (i) { apply(i, false); } };
}
