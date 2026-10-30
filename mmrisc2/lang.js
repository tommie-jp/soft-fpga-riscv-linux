'use strict';
// lang.js — ページの日本語と英語を切り替える (目次とコアのページで共通)
//
// 本文は両方の言語を書いておき、lang="ja" / lang="en" の付いた要素の片方を CSS で隠す
// (html[data-lang] で切り替える)。#lang-toggle を押すと替わる。
// 初めの言語は ?lang=ja|en → 前に選んだ物 (localStorage) → ブラウザの言語 の順で決める。
// スクリプトで作る文言は SFRL_LANG.onChange(fn) で、言語が決まった時と替わった時に作り直す。
(function () {
  var KEY = 'sfrl_lang';
  var LANGS = ['ja', 'en'];
  var listeners = [];

  function pick() {
    var q = new URLSearchParams(location.search).get('lang');
    if (LANGS.indexOf(q) >= 0) return q;
    try {
      var saved = localStorage.getItem(KEY);
      if (LANGS.indexOf(saved) >= 0) return saved;
    } catch (e) { /* localStorage が使えない (プライベートモードなど) なら、ブラウザの言語で決める */ }
    return (navigator.language || '').toLowerCase().indexOf('ja') === 0 ? 'ja' : 'en';
  }

  var current = pick();

  function apply() {
    var html = document.documentElement;
    html.lang = current;
    html.setAttribute('data-lang', current);
    var btn = document.getElementById('lang-toggle');
    if (btn) btn.textContent = current === 'ja' ? 'English' : '日本語';
    listeners.forEach(function (fn) { fn(current); });
  }

  function set(lang) {
    current = lang;
    try { localStorage.setItem(KEY, lang); } catch (e) { /* 覚えられないだけで、切り替えはできる */ }
    apply();
  }

  window.SFRL_LANG = {
    get: function () { return current; },
    onChange: function (fn) { listeners.push(fn); fn(current); }
  };

  // 本文が出る前に data-lang を付け、両方の言語が一瞬並ぶのを防ぐ
  document.documentElement.setAttribute('data-lang', current);
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('lang-toggle');
    if (btn) btn.addEventListener('click', function () { set(current === 'ja' ? 'en' : 'ja'); });
    apply();
  });
})();
