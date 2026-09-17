// ⚔️ 实战OKX — 开仓风格图表 + 双向自动开仓 + 资金流失速度
const B$ = (id) => document.getElementById(id);
const OKX = "https://www.okx.com/api/v5";
const BN = "https://data-api.binance.vision";
let usingFallback = false;

// ---- 币池(和开仓主页一致, 支持URL入参扩展) ----
let COINS = [
  { sym: "BTC", name: "比特币" }, { sym: "ETH", name: "以太坊" },
  { sym: "SOL", name: "" }, { sym: "XRP", name: "瑞波币" },
  { sym: "DOGE", name: "狗狗币" }, { sym: "LSK", name: "" },
];
let curCoin = "BTC";
let productType = "SPOT";
let curPrice = 0;
let k5 = [];          // 5分钟K线(49根=4小时)
let aggTrades = [];   // 大单成交
let longPos = null, shortPos = null;
let priceHistory = [];

// ---- 工具 ----
const fmtP = (p) => p >= 1000 ? p.toLocaleString("en-US",{maximumFractionDigits:1})
  : p >= 1 ? (+p).toFixed(3) : (+p).toPrecision(5);
// 关键修改: 负数带负号
const fmtU = (v) => (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(2);
const clsPnL = (v) => v >= 0 ? "bt-green" : "bt-red";
const pctS = (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";

// ---- 数据获取(OKX优先→币安兜底) ----
async function fetchKlines(sym) {
  const instId = sym + "-USDT";
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${OKX}/market/candles?instId=${instId}&bar=5m&limit=49`, { signal: ctrl.signal });
    const d = await r.json();
    if (d.code === "0" && d.data?.length) {
      usingFallback = false;
      return d.data.map(k => ({ ts: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], tb: +k[5] / 2 })).reverse();
    }
    throw new Error("empty");
  } catch (e) {
    usingFallback = true;
    const r = await fetch(`${BN}/api/v3/klines?symbol=${sym}USDT&interval=5m&limit=49`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return d.map(k => ({ ts: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], tb: +k[10] || +k[5] / 2 }));
  }
}

async function fetchPrice(sym) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${OKX}/market/ticker?instId=${sym}-USDT`, { signal: ctrl.signal });
    const d = await r.json();
    if (d.code === "0" && d.data?.[0]) {
      usingFallback = false;
      curPrice = +d.data[0].last;
    } else throw new Error("empty");
  } catch (e) {
    usingFallback = true;
    const r = await fetch(`${BN}/api/v3/ticker/price?symbol=${sym}USDT`, { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    curPrice = +d.price;
  }
  priceHistory.push({ ts: Date.now(), price: curPrice });
  if (priceHistory.length > 600) priceHistory.shift();
  B$("btDot").className = "bt-dot bt-ok";
  B$("btLast").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false })
    + (usingFallback ? " 币安" : " OKX");
}

async function fetchTrades(sym) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${OKX}/market/trades?instId=${sym}-USDT&limit=100`, { signal: ctrl.signal });
    const d = await r.json();
    if (d.code === "0") {
      return d.data.map(t => ({ p: +t.px, q: +t.sz, buy: t.side === "buy", ts: +t.ts }));
    }
    throw new Error("empty");
  } catch (e) {
    const r = await fetch(`${BN}/api/v3/aggTrades?symbol=${sym}USDT&limit=500`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return d.map(t => ({ p: +t.p, q: +t.q, buy: t.m === false, ts: +t.T }));
  }
}

// ---- 币种条(和开仓主页同款) ----
async function renderCoinStrip() {
  const strip = B$("btCoinStrip");
  const prices = await Promise.all(COINS.map(c =>
    fetch(`${BN}/api/v3/ticker/24hr?symbol=${c.sym}USDT`, { signal: AbortSignal.timeout(6000) })
      .then(r => r.json()).catch(() => null)));
  strip.innerHTML = COINS.map((c, i) => {
    const t = prices[i];
    const p = t ? +t.lastPrice : 0;
    const chg = t ? +t.priceChangePercent : 0;
    const cls = chg >= 0 ? "up" : "down";
    return `<div class="cc-chip${c.sym === curCoin ? " active" : ""}" data-sym="${c.sym}">
      <div class="cc-sym">${c.sym}${c.name ? ` <span style="color:var(--muted);font-size:10px">${c.name}</span>` : ""}</div>
      <div class="cc-price">${p ? fmtP(p) : "--"}</div>
      <div class="cc-chg ${cls}">${pctS(chg)}</div>
    </div>`;
  }).join("");
  strip.querySelectorAll(".cc-chip").forEach(el =>
    el.addEventListener("click", () => {
      curCoin = el.dataset.sym;
      onCoinChange();
    }));
}

// ---- 价格走势图(和开仓主页同款SVG) ----
function renderPriceChart() {
  if (!k5.length) return;
  const done = k5.slice(0, -1);
  const closes = done.map(k => k.c);
  const W = 420, H = 150, PL = 55, PR = 8, PT = 8, PB = 18;
  const cw = W - PL - PR, chh = H - PT - PB;
  const minP = Math.min(...closes), maxP = Math.max(...closes);
  const range = maxP - minP || 1;
  const x = i => PL + i / (closes.length - 1) * cw;
  const y = p => PT + (1 - (p - minP) / range) * chh;
  const chg = closes[closes.length - 1] / closes[0] - 1;
  const lc = chg >= 0 ? "#e54545" : "#24b28c";
  const pts = closes.map((c, i) => `${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(" ");
  // 统计线
  const avg = closes.reduce((s, v) => s + v, 0) / closes.length;
  const sorted = [...closes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const modeMap = {};
  closes.forEach(c => { const k = c.toFixed(4); modeMap[k] = (modeMap[k] || 0) + 1; });
  const modeCount = Math.max(...Object.values(modeMap));
  const mode = modeCount > 3 ? +Object.keys(modeMap).find(k => modeMap[k] === modeCount) : null;
  let statLines = "";
  if (avg >= minP && avg <= maxP) statLines += `<line x1="${PL}" y1="${y(avg)}" x2="${W-PR}" y2="${y(avg)}" stroke="#a855f7" stroke-width="0.8" stroke-dasharray="6,3" opacity="0.7"/><text x="${PL+2}" y="${y(avg)-2}" font-size="7.5" fill="#a855f7">均${fmtP(avg)}</text>`;
  if (median >= minP && median <= maxP) statLines += `<line x1="${PL}" y1="${y(median)}" x2="${W-PR}" y2="${y(median)}" stroke="#f0b90b" stroke-width="0.8" stroke-dasharray="3,3" opacity="0.6"/><text x="${PL+2}" y="${y(median)-2}" font-size="7.5" fill="#f0b90b">中${fmtP(median)}</text>`;
  if (mode && mode >= minP && mode <= maxP && modeCount > 3) statLines += `<line x1="${PL}" y1="${y(mode)}" x2="${W-PR}" y2="${y(mode)}" stroke="#24b28c" stroke-width="0.8" stroke-dasharray="1,3" opacity="0.6"/><text x="${PL+2}" y="${y(mode)-2}" font-size="7.5" fill="#24b28c">众${fmtP(mode)}×${modeCount}</text>`;

  B$("btPriceChart").innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    <polygon points="${PL},${H-PB} ${pts} ${x(closes.length-1)},${H-PB}" fill="${lc}" opacity="0.08"/>
    <polyline points="${pts}" fill="none" stroke="${lc}" stroke-width="1.5"/>
    ${statLines}
    <circle cx="${x(closes.length-1)}" cy="${y(curPrice || closes[closes.length-1])}" r="2.5" fill="${lc}"/>
    <text x="${W-PR}" y="13" text-anchor="end" font-size="10" fill="${lc}" font-weight="700">${pctS(chg*100)}</text>
    <text x="${PL}" y="${H-6}" font-size="8" fill="#7a8299">${new Date(done[0].ts).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</text>
    <text x="${W-PR}" y="${H-6}" text-anchor="end" font-size="8" fill="#7a8299">${new Date(done[done.length-1].ts).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</text>
  </svg>`;
  B$("btPriceInfo").innerHTML = `现价 <b>${fmtP(curPrice)}</b> · 均${fmtP(avg)} 中${fmtP(median)}${mode ? ` 众${fmtP(mode)}×${modeCount}` : ""} · ${pctS(chg * 100)}`;
}

// ---- 成交量·主动买占比图 ----
function renderVolChart() {
  if (!k5.length) return;
  const done = k5.slice(0, -1);
  const W = 420, H = 110, PL = 8, PR = 8, PT = 15, PB = 18;
  const cw = W - PL - PR, chh = H - PT - PB;
  const totalVols = done.map(k => k.v);
  const maxV = Math.max(...totalVols) || 1;
  const barW = cw / done.length * 0.7;
  let bars = "";
  done.forEach((k, i) => {
    const h = k.v / maxV * chh;
    const x = PL + i / done.length * cw;
    const ratio = k.tb / k.v;
    const buyH = h * ratio, sellH = h * (1 - ratio);
    bars += `<rect x="${x}" y="${PT + chh - buyH}" width="${barW}" height="${buyH}" fill="#e54545" opacity="0.75" rx="1"/>`;
    bars += `<rect x="${x}" y="${PT + chh - buyH - sellH}" width="${barW}" height="${sellH}" fill="#24b28c" opacity="0.6" rx="1"/>`;
  });
  // 买占比折线
  const ratios = done.map(k => k.tb / k.v);
  const rY = r => PT + (1 - r) * chh;
  const rPts = ratios.map((r, i) => `${(PL + i / done.length * cw + barW / 2).toFixed(1)},${rY(r).toFixed(1)}`).join(" ");
  const avgRatio = ratios.reduce((s, v) => s + v, 0) / ratios.length;
  B$("btVolChart").innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    <line x1="${PL}" y1="${rY(avgRatio)}" x2="${W-PR}" y2="${rY(avgRatio)}" stroke="#f0b90b" stroke-width="0.8" stroke-dasharray="4,3" opacity="0.7"/>
    <text x="${W-PR}" y="${rY(avgRatio)-2}" text-anchor="end" font-size="8" fill="#f0b90b">均${(avgRatio*100).toFixed(0)}%</text>
    ${bars}
    <polyline points="${rPts}" fill="none" stroke="#f0b90b" stroke-width="1.2" opacity="0.9"/>
    <text x="${W-PR}" y="11" text-anchor="end" font-size="9" fill="${avgRatio > 0.5 ? "#e54545" : "#24b28c"}" font-weight="700">买占比${(avgRatio*100).toFixed(1)}%</text>
  </svg>`;
  const totalBuy = done.reduce((s, k) => s + k.tb, 0);
  const totalV = done.reduce((s, k) => s + k.v, 0);
  B$("btVolInfo").innerHTML = `4h主动买占比 <b style="color:${totalBuy / totalV > 0.5 ? "var(--up)" : "var(--down)"}">${(totalBuy / totalV * 100).toFixed(1)}%</b> · 买占比>55%为买方主导`;
}

// ---- 侧栏实时价格 ----
function updateSidePrices() {
  if (curPrice > 0) {
    const prev = priceHistory.length >= 2 ? priceHistory[priceHistory.length - 2].price : curPrice;
    const chg = curPrice - prev;
    const cls = chg >= 0 ? "bt-green" : "bt-red";
    const html = `<span class="${cls}">${fmtP(curPrice)}</span> <span style="font-size:10px;color:var(--muted)">${chg >= 0 ? "\u2191" : "\u2193"}${fmtP(Math.abs(chg))}</span>`;
    B$("btLongCurPrice").innerHTML = html;
    B$("btShortCurPrice").innerHTML = html;
  }
}

// ---- 自动开仓 ----
function autoOpen() {
  if (curPrice <= 0) return;
  const M = 100, L = 10, now = Date.now();
  longPos = { dir: "long", margin: M, lev: L, entry: curPrice, entryTime: now, qty: M * L / curPrice, pnl: 0, speed: 0 };
  shortPos = { dir: "short", margin: M, lev: L, entry: curPrice, entryTime: now, qty: M * L / curPrice, pnl: 0, speed: 0 };
  priceHistory = [{ ts: now, price: curPrice }];
  renderPositions();
}

// ---- 盈亏计算与渲染 ----
function updatePnl() {
  if (curPrice <= 0) return;
  const now = Date.now();
  for (const pos of [longPos, shortPos]) {
    if (!pos) continue;
    const isLong = pos.dir === "long";
    const chg = isLong ? (curPrice / pos.entry - 1) : (1 - curPrice / pos.entry);
    pos.pnl = pos.margin * pos.lev * chg;
    const recent = priceHistory.filter(p => now - p.ts <= 60000);
    if (recent.length >= 2) {
      const r0 = recent[0], rN = recent[recent.length - 1];
      const mChg = isLong ? (rN.price / r0.price - 1) : (1 - rN.price / r0.price);
      pos.speed = pos.margin * pos.lev * mChg;
    } else pos.speed = 0;
  }
  renderPositions();
}

function renderPositions() {
  for (const [prefix, pos] of [["btLong", longPos], ["btShort", shortPos]]) {
    if (!pos) continue;
    const pnlEl = B$(prefix + "Pnl");
    pnlEl.textContent = fmtU(pos.pnl);  // 负数带负号: -$1.65
    pnlEl.className = "bt-pnl " + clsPnL(pos.pnl);
    B$(prefix + "Entry").innerHTML = `入场 <b>${fmtP(pos.entry)}</b> → <b>${fmtP(curPrice)}</b>`;
    const remaining = Math.max(0, pos.margin + pos.pnl);
    const pct = Math.max(0, Math.min(100, remaining / pos.margin * 100));
    const fill = B$(prefix + "Fill");
    fill.style.width = pct + "%";
    fill.className = "bt-fundbar-fill" + (pos.dir === "short" ? " short" : "") + (pct < 50 ? " danger" : pct < 80 ? " warn" : "");
    B$(prefix + "Label").textContent = `$${remaining.toFixed(2)} (${pct.toFixed(1)}%)`;
    const spd = pos.speed || 0;
    const spdEl = B$(prefix + "Speed");
    spdEl.textContent = `${spd >= 0 ? "+" : "-"}$${Math.abs(spd).toFixed(2)}/分钟`;
    spdEl.className = "bt-speed " + clsPnL(spd);
    B$(prefix + "Detail").innerHTML = `
      <div><span>仓位</span><b>$${(pos.margin * pos.lev).toLocaleString()}</b></div>
      <div><span>杠杆</span><b>${pos.lev}x</b></div>
      <div><span>价格变动</span><b>${pctS((curPrice / pos.entry - 1) * 100)}</b></div>
      <div><span>持仓</span><b>${Math.round((Date.now() - pos.entryTime) / 1000)}秒</b></div>`;
  }
  const total = (longPos ? longPos.margin + longPos.pnl : 0) + (shortPos ? shortPos.margin + shortPos.pnl : 0);
  const tp = Math.max(0, Math.min(100, total / 200 * 100));
  B$("btTotalVal").textContent = `$${total.toFixed(2)}`;
  B$("btTotalFill").style.width = tp + "%";
  B$("btTotalFill").className = "bt-total-fill" + (tp < 50 ? " danger" : tp < 80 ? " warn" : "");
}

// ---- 切换币种 ----
async function onCoinChange() {
  k5 = []; aggTrades = []; priceHistory = [];
  longPos = shortPos = null;
  const sb = B$("btStartBtn");
  if (sb) { sb.textContent = "\ud83c\udfaf \u5f00\u59cb\u76d1\u63a7\u5165\u5c40"; sb.classList.remove("active"); }
  renderPriceChart(); renderVolChart();
  renderCoinStrip();  // 更新高亮
  await fetchPrice(curCoin);
  k5 = await fetchKlines(curCoin);
  aggTrades = await fetchTrades(curCoin);
  renderPriceChart(); renderVolChart();
  updateSidePrices();
}

// ---- 雷达弹框 ----
B$("btRadarBtn").addEventListener("click", () => B$("btRadarOverlay").classList.remove("hidden"));
B$("btRadarClose").addEventListener("click", () => B$("btRadarOverlay").classList.add("hidden"));
B$("btRadarOverlay").addEventListener("click", (e) => { if (e.target.id === "btRadarOverlay") B$("btRadarOverlay").classList.add("hidden"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") B$("btRadarOverlay").classList.add("hidden"); });

// ---- 透视 ----
B$("btXrayPrice").addEventListener("click", () => openXray("量价分布"));
B$("btXrayVol").addEventListener("click", () => openXray("大单成交"));
B$("btXrayClose").addEventListener("click", () => B$("btXrayOverlay").classList.add("hidden"));
B$("btXrayOverlay").addEventListener("click", (e) => { if (e.target.id === "btXrayOverlay") B$("btXrayOverlay").classList.add("hidden"); });

function openXray(title) {
  B$("btXrayTitle").textContent = `${curCoin}/USDT · ${title}`;
  B$("btXrayOverlay").classList.remove("hidden");
  if (title === "大单成交") {
    const minQ = Math.max(1, 10000 / curPrice);
    const large = aggTrades.filter(t => t.q >= minQ).slice(0, 30);
    B$("btXrayTrades").innerHTML = large.length ? large.map(t =>
      `<div class="bt-xt-row">
        <span class="${t.buy ? "bt-green" : "bt-red"}">${t.buy ? "🟢买" : "🔴卖"}</span>
        <span>${fmtP(t.p)}</span><span>${t.q.toFixed(4)}</span>
        <span>$${(t.p * t.q).toFixed(0)}</span>
      </div>`).join("") : "<span class='bt-loading'>4小时窗口内无大单</span>";
  } else {
    // 量价分布: 按价格分桶
    const done = k5.slice(0, -1);
    if (!done.length) { B$("btXrayTrades").innerHTML = "<span class='bt-loading'>无数据</span>"; return; }
    const buckets = {};
    done.forEach(k => {
      const p = k.c.toFixed(curPrice >= 100 ? 0 : curPrice >= 1 ? 3 : 6);
      buckets[p] = (buckets[p] || 0) + k.v;
    });
    const maxV = Math.max(...Object.values(buckets));
    B$("btXrayTrades").innerHTML = Object.entries(buckets)
      .sort((a, b) => +a[0] - +b[0])
      .map(([p, v]) => {
        const w = v / maxV * 100;
        const isCurrent = Math.abs(+p - curPrice) < (curPrice * 0.001);
        return `<div class="bt-vp-row">
          <span class="bt-vp-price ${isCurrent ? "bt-vp-cur" : ""}">${p}</span>
          <div class="bt-vp-bar"><div style="width:${w}%;background:${isCurrent ? "var(--accent)" : "var(--border)"};height:10px;border-radius:3px"></div></div>
        </div>`;
      }).join("");
  }
}

// ---- 开始监控入局 ----
B$("btStartBtn").addEventListener("click", () => {
  if (curPrice <= 0) { alert("价格未加载"); return; }
  autoOpen();
  const btn = B$("btStartBtn");
  btn.textContent = "\u2705 \u5df2\u5165\u5c40";
  btn.classList.add("active");
  setTimeout(() => { btn.textContent = "\ud83c\udfaf \u5f00\u59cb\u76d1\u63a7\u5165\u5c40"; btn.classList.remove("active"); }, 3000);
});


// ---- 事件 ----
document.querySelectorAll(".bt-tab").forEach(btn =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".bt-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    productType = btn.dataset.pt;
  }));

// ---- 定时刷新 ----
let tickTimer = null;
function startTick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(async () => {
    await fetchPrice(curCoin);
    updatePnl();
    renderPriceChart();
    updateSidePrices();
    updateCalc();
    if (+B$("btEntry").value === 0 || !B$("btEntry").value) updateStrat();
  }, 5000);
  setInterval(async () => {
    k5 = await fetchKlines(curCoin);
    aggTrades = await fetchTrades(curCoin);
    renderVolChart();
  }, 60000);
}

// ---- URL入参(和开仓主页一致) ----
function parseUrlCoin() {
  const c = new URLSearchParams(location.search).get("coin");
  if (c) {
    const sym = c.replace("USDT", "").toUpperCase();
    if (!COINS.find(x => x.sym === sym)) COINS.push({ sym, name: "" });
    curCoin = sym;
  }
}

// ---- 启动 ----
(async function init() {
  parseUrlCoin();
  await renderCoinStrip();
  await onCoinChange();
  startTick();
})();

// ==================== 策略参数 + 计算器 ====================
let btDir = "long";
B$("btDirLong").addEventListener("click", () => { btDir = "long"; B$("btDirLong").classList.add("active"); B$("btDirShort").classList.remove("active"); updateStrat(); });
B$("btDirShort").addEventListener("click", () => { btDir = "short"; B$("btDirShort").classList.add("active"); B$("btDirLong").classList.remove("active"); updateStrat(); });
["btMargin", "btLev", "btEntry", "btExit"].forEach(id => B$(id).addEventListener("input", updateStrat));
function updateStrat() {
  const m = +B$("btMargin").value || 100;
  const lev = Math.min(125, Math.max(1, +B$("btLev").value || 10));
  const entry = +B$("btEntry").value || curPrice;
  const exit = +B$("btExit").value || entry;
  if (entry <= 0) return;
  const imr = 1 / lev, mmr = 0.005;
  const liq = btDir === "long" ? entry * (1 - imr + mmr) : entry * (1 + imr - mmr);
  const qty = m * lev / entry;
  const pnl = btDir === "long" ? (exit - entry) * qty : (entry - exit) * qty;
  B$("btStratPreview").innerHTML = `
    ${btDir === "long" ? "📈做多" : "📉做空"} | 仓位 $${(m*lev).toLocaleString()} (${qty<1?qty.toFixed(6):qty.toFixed(3)}) |
    爆仓 <b class="bt-red">${fmtP(liq)}</b> |
    入→出 ${fmtP(entry)}→${fmtP(exit)} 盈亏 <b class="${pnl>=0?'bt-green':'bt-red'}">${fmtU(pnl)}</b>`;
}

// 计算器
["btCalcLev", "btCalcMargin", "btMmr"].forEach(id => B$(id).addEventListener("input", updateCalc));
B$("btEntry")?.addEventListener("input", updateCalc);
function updateCalc() {
  const lev = Math.min(125, Math.max(1, +B$("btCalcLev").value || 10));
  const m = +B$("btCalcMargin").value || 100;
  const mmr = +B$("btMmr").value || 0.005;
  const entry = +B$("btEntry").value || curPrice;
  const exit = +B$("btExit").value || entry;
  if (entry <= 0) return;
  const imr = 1 / lev;
  const liqL = entry * (1 - imr + mmr), liqS = entry * (1 + imr - mmr);
  B$("btLiqLong").textContent = fmtP(liqL);
  B$("btLiqShort").textContent = fmtP(liqS);
  B$("btSlLong").textContent = fmtP(entry * 0.99);
  B$("btSlShort").textContent = fmtP(entry * 1.01);
  B$("btTpLong").textContent = fmtP(entry * 1.02);
  B$("btTpShort").textContent = fmtP(entry * 0.98);
  const qty = m * lev / entry;
  const pnlL = (exit - entry) * qty, pnlS = (entry - exit) * qty;
  B$("btPnlLong").textContent = fmtU(pnlL);
  B$("btPnlLong").className = pnlL >= 0 ? "bt-green" : "bt-red";
  B$("btPnlShort").textContent = fmtU(pnlS);
  B$("btPnlShort").className = pnlS >= 0 ? "bt-green" : "bt-red";
  B$("btPosSize").textContent = "$" + (m * lev).toLocaleString();
  B$("btTpProfit").textContent = "+$" + (m * lev * 0.02).toFixed(2);
}
// 初始触发
updateStrat(); updateCalc();
