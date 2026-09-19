/* js/app.js — 穆夏塔罗主逻辑（批次 A：无动效）
 * 依赖：js/data.js（TAROT_CARDS / TAROT_BY_ID）、data/meanings.js（TAROT_MEANINGS）
 * 无框架、无构建、无外部请求。
 *
 * 抽牌规则：
 *   - Fisher-Yates 洗乱全部 78 张
 *   - 取前 3 张，分别对应 过去 / 现在 / 未来，天然不重复
 *   - 每张独立 50% 概率逆位
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'tarot_history';
  var HISTORY_LIMIT = 30;
  var POSITIONS = ['过去', '现在', '未来'];

  var el = {
    drawBtn: document.getElementById('drawBtn'),
    drawHint: document.getElementById('drawHint'),
    result: document.getElementById('result'),
    historyList: document.getElementById('historyList'),
    clearBtn: document.getElementById('clearBtn')
  };

  /* ---------------- 随机 ---------------- */

  // 优先用 crypto，不可用时退回 Math.random
  function randInt(max) {
    if (window.crypto && window.crypto.getRandomValues) {
      var a = new Uint32Array(1);
      // 拒绝采样，避免取模偏差
      var limit = Math.floor(4294967296 / max) * max;
      do { window.crypto.getRandomValues(a); } while (a[0] >= limit);
      return a[0] % max;
    }
    return Math.floor(Math.random() * max);
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = randInt(i + 1);
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* ---------------- 抽牌 ---------------- */

  // 返回 [{ id, reversed }, ...] 长度 3
  function drawThree() {
    var pool = shuffle(TAROT_CARDS.slice());
    var out = [];
    for (var i = 0; i < 3; i++) {
      out.push({ id: pool[i].id, reversed: randInt(2) === 1 });
    }
    return out;
  }

  /* ---------------- 历史（localStorage） ---------------- */

  function loadHistory() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var data = JSON.parse(raw);
      if (!Object.prototype.toString.call(data).match(/Array/)) return [];
      // 过滤掉结构损坏的记录
      return data.filter(function (r) {
        return r && typeof r.time === 'number' && Object.prototype.toString.call(r.cards).match(/Array/)
          && r.cards.length === 3
          && r.cards.every(function (c) { return c && TAROT_BY_ID[c.id]; });
      });
    } catch (e) {
      return [];
    }
  }

  function saveHistory(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
      return true;
    } catch (e) {
      // 隐私模式或配额满：静默失败，不影响抽牌
      return false;
    }
  }

  function addHistory(cards) {
    var list = loadHistory();
    list.unshift({ time: Date.now(), cards: cards });
    var ok = saveHistory(list);
    if (!ok) noteStorageBlocked();
    return list;
  }

  var storageWarned = false;
  function noteStorageBlocked() {
    if (storageWarned) return;
    storageWarned = true;
    el.drawHint.textContent = '本次记录无法保存（浏览器可能禁用了本地存储）';
  }

  /* ---------------- 渲染 ---------------- */

  function formatTime(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function makeEl(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderCard(entry, posIndex) {
    var meta = TAROT_BY_ID[entry.id];
    var mean = TAROT_MEANINGS[entry.id];
    var rev = !!entry.reversed;

    var box = makeEl('div', 'card');
    box.setAttribute('data-card-id', entry.id);

    box.appendChild(makeEl('p', 'card-pos', POSITIONS[posIndex]));

    var imgwrap = makeEl('div', 'card-imgwrap');
    var img = document.createElement('img');
    img.src = 'cards/' + meta.file;
    img.alt = meta.name + (rev ? '（逆位）' : '（正位）');
    img.loading = 'eager';
    img.decoding = 'async';
    if (rev) img.className = 'is-reversed';
    imgwrap.appendChild(img);
    box.appendChild(imgwrap);

    var head = makeEl('div', 'card-head');
    var nameLine = makeEl('div', 'card-name');
    nameLine.appendChild(document.createTextNode(meta.name));
    var badge = makeEl('span', 'badge' + (rev ? ' badge-rev' : ''), rev ? '逆位' : '正位');
    nameLine.appendChild(badge);
    head.appendChild(nameLine);
    head.appendChild(makeEl('div', 'card-en', meta.en + ' · ' + meta.suitCn));
    box.appendChild(head);

    var keys = mean ? (rev ? mean.revKeys : mean.upKeys) : [];
    var ul = makeEl('ul', 'keys');
    keys.forEach(function (k) { ul.appendChild(makeEl('li', null, k)); });
    box.appendChild(ul);

    var p = makeEl('p', 'meaning');
    p.appendChild(makeEl('span', 'meaning-label', rev ? '逆位牌义' : '正位牌义'));
    p.appendChild(document.createTextNode(mean ? (rev ? mean.rev : mean.up) : '暂无牌义数据'));
    box.appendChild(p);

    return box;
  }

  function renderReading(cards) {
    // .result 本身是三列网格，直接替换其子节点
    el.result.textContent = '';
    cards.forEach(function (c, i) { el.result.appendChild(renderCard(c, i)); });
  }

  function renderHistory(list) {
    el.historyList.textContent = '';
    if (!list.length) {
      el.historyList.appendChild(makeEl('p', 'history-empty', '暂无记录'));
      return;
    }
    list.forEach(function (rec) {
      var btn = makeEl('button', 'history-item');
      btn.type = 'button';
      btn.appendChild(makeEl('span', 'history-time', formatTime(rec.time)));
      var line = makeEl('span', 'history-cards');
      rec.cards.forEach(function (c, i) {
        var meta = TAROT_BY_ID[c.id];
        if (i > 0) line.appendChild(makeEl('em', null, ' ／ '));
        line.appendChild(document.createTextNode(meta ? meta.name : c.id));
        line.appendChild(makeEl('em', null, c.reversed ? '（逆）' : '（正）'));
      });
      btn.appendChild(line);
      // 点击历史记录可重新查看该次结果（不新增记录）
      btn.addEventListener('click', function () { renderReading(rec.cards); });
      el.historyList.appendChild(btn);
    });
  }

  /* ---------------- 事件 ---------------- */

  var drawing = false;

  function onDraw() {
    if (drawing) return;
    drawing = true;
    el.drawBtn.disabled = true;

    var cards = drawThree();
    renderReading(cards);
    renderHistory(addHistory(cards));

    el.drawBtn.disabled = false;
    el.drawBtn.textContent = '再抽一次';
    el.drawHint.textContent = '78 张牌，正逆位随机';
    drawing = false;
  }

  function onClear() {
    if (!loadHistory().length) return;
    if (!window.confirm('确定清空全部抽牌记录？此操作无法撤销。')) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    renderHistory([]);
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    if (typeof TAROT_CARDS === 'undefined' || TAROT_CARDS.length !== 78) {
      el.drawBtn.disabled = true;
      el.drawHint.textContent = '牌面数据加载失败，请刷新页面';
      return;
    }
    el.drawBtn.addEventListener('click', onDraw);
    el.clearBtn.addEventListener('click', onClear);
    renderHistory(loadHistory());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
