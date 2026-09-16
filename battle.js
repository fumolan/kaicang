// ⚔️ 实战OKX — 双向自动开仓 + 资金流失速度体验
const B$ = (id) => document.getElementById(id);
const OKX = "https://www.okx.com/api/v5";

// ---- 状态 ----
let productType = "SPOT";     // SPOT | SWAP | FUTURES | OPTION
let curInst = "";             // 当前品种 instId
let curPrice = 0;
let longPos = null, shortPos = null;
let priceHistory = [];        // [{ts, price}] 用于计算亏损速度
let candles = [], trades = [];
let timer = null, tickTimer = null;
let records = [];
const RECORD_KEY = "battle_records_v1";

// ---- 工具 ----
const fmtP = (p) => p >= 1000 ? p.toLocaleString("en-US",{maximumFractionDigits:1})
  : p >= 1 ? (+p).toFixed(3) : (+p).toPrecision(5);
const fmtU = (v) => (v >= 0 ? "+" : "") + "$" + Math.abs(v).toFixed(2);
const clsPnL = (v) => v >= 0 ? "bt-green" : "bt-red";

let usingFallback = false;   // OKX不通时用币安兜底
const BN = "https://data-api.binance.vision";

async function okx(path, timeout = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(OKX + path, { signal: ctrl.signal });
    clearTimeout(t);
    const d = await r.json();
    if (d.code !== "0") throw new Error(d.msg || "OKX " + d.code);
    usingFallback = false;
    return d.data;
  } catch (e) {
    clearTimeout(t);
    // OKX不通 → 币安兜底(国内直连)
    return await binanceFallback(path);
  }
}

// 币安兜底: 用现货数据近似(价格差<0.1%, 对体验资金流失速度足够)
async function binanceFallback(okxPath) {
  usingFallback = true;
  // 提取币种: instId=BTC-USDT 或 BTC-USDT-SWAP 等
  const instMatch = okxPath.match(/instId=([A-Z0-9-]+)/);
  const base = instMatch ? instMatch[1].split("-")[0] : "BTC";
  const sym = base + "USDT";
  if (okxPath.includes("/market/ticker")) {
    const r = await fetch(BN + "/api/v3/ticker/price?symbol=" + sym, { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    return [{ instId: instMatch?.[1] || sym, last: d.price, ts: String(Date.now()) }];
  }
  if (okxPath.includes("/market/candles") || okxPath.includes("candles")) {
    const r = await fetch(BN + "/api/v3/klines?symbol=" + sym + "&interval=1h&limit=120", { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    // 币安格式: [openTime, o, h, l, c, vol, closeTime, ...] 旧→新
    return d.map(k => [String(k[0]), String(k[1]), String(k[2]), String(k[3]), String(k[4]), String(k[5]), "0", "0", true]);
  }
  if (okxPath.includes("/market/trades")) {
    const r = await fetch(BN + "/api/v3/aggTrades?symbol=" + sym + "&limit=20", { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    // 币安: m=true=卖方主动, side= sell; m=false=买方主动
    return d.map((t, i) => ({ instId: sym, tradeId: String(t.a), px: String(t.p), sz: String(t.q), side: t.m ? "sell" : "buy", ts: String(t.T) }));
  }
  // 交割/期权的公开合约信息 → 返回空(品种列表用硬编码兜底)
  return [];
}

// ---- 品种列表 ----
const COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE"];
let futureList = [];  // 交割合约
let optionList = [];  // 期权链

async function loadInstruments() {
  try {
    let items = [];
    if (productType === "SPOT" || productType === "SWAP") {
      const type = productType === "SPOT" ? "" : "-SWAP";
      items = COINS.map(c => ({ id: `${c}-USDT${type}`, label: c, sub: productType === "SPOT" ? "现货" : "永续" }));
    } else if (productType === "FUTURES") {
      if (!futureList.length) {
        let list = [];
        try { list = await okx("/public/instruments?instType=FUTURES&instFamily=BTC-USD"); } catch(e) {}
        if (!list.length && usingFallback) {
          // 币安兜底: 硬编码BTC交割合约(2026下半年)
          list = [
            { instId: "BTC-USD-260925", alias: "this_month", expTime: String(new Date("2026-09-25").getTime()), state: "live" },
            { instId: "BTC-USD-261030", alias: "next_month", expTime: String(new Date("2026-10-30").getTime()), state: "live" },
            { instId: "BTC-USD-261225", alias: "quarter", expTime: String(new Date("2026-12-25").getTime()), state: "live" },
            { instId: "BTC-USD-270326", alias: "next_quarter", expTime: String(new Date("2027-03-26").getTime()), state: "live" },
          ];
        }
        futureList = list.filter(x => x.state === "live").map(x => ({
          id: x.instId, alias: x.alias, exp: new Date(+x.expTime).toLocaleDateString("zh-CN", {month:"short",day:"numeric"})
        }));
      }
      items = futureList.map(f => ({ id: f.id, label: f.id.replace("BTC-USD-",""), sub: f.alias === "this_month" ? "当月" : f.alias === "next_month" ? "次月" : f.alias === "quarter" ? "当季" : f.alias === "next_quarter" ? "次季" : f.alias }));
    } else if (productType === "OPTION") {
      if (!optionList.length) {
        // 取最近到期的BTC看涨期权 (ATM附近)
        const list = await okx("/public/instruments?instType=OPTION&instFamily=BTC-USD");
        const live = list.filter(x => x.state === "live");
        if (live.length) {
          // 找最近到期
          const sorted = [...live].sort((a, b) => +a.expTime - +a.expTime);
          const nearest = sorted[0].expTime;
          const nearList = live.filter(x => x.expTime === nearest && x.optType === "C");
          // 取BTC现价附近strike
          const ticker = await okx("/market/ticker?instId=BTC-USDT");
          const btc = +ticker[0].last;
          const atm = nearList.filter(x => Math.abs(+x.stk - btc) / btc < 0.15)
            .sort((a, b) => +a.stk - +b.stk)
            .slice(0, 7);
          optionList = atm.map(x => ({ id: x.instId, strike: x.stk, exp: new Date(+x.expTime).toLocaleDateString("zh-CN",{month:"short",day:"numeric"}) }));
        }
      }
      items = optionList.map(o => ({ id: o.id, label: `${o.strike}C`, sub: o.exp }));
    }
    // 渲染卡片条
    renderInstCards(items);
    curInst = items[0]?.id || "";
    if (curInst) onInstrumentChange();
    renderInstCards(items);
  } catch (e) {
    renderInstCards([{ id: "", label: "加载失败", sub: e.message.slice(0, 20) }]);
  }
}

function renderInstCards(items) {
  B$("btInstStrip").innerHTML = items.map(it => `
    <div class="bt-ic${it.id === curInst ? " active" : ""}" data-inst="${it.id}">
      <div class="bt-ic-label">${it.label}</div>
      <div class="bt-ic-sub">${it.sub || ""}</div>
    </div>`).join("");
  B$("btInstStrip").querySelectorAll(".bt-ic").forEach(el =>
    el.addEventListener("click", () => {
      curInst = el.dataset.inst;
      if (curInst) onInstrumentChange();
    }));
}

// ---- 自动开仓 ----
function autoOpen() {
  if (!curInst || curPrice <= 0) return;
  const MARGIN = 100, LEV = 10;
  const isOption = productType === "OPTION";
  const now = Date.now();
  // 现货做多: 买入等值币; 做空/合约: 模拟合约
  longPos = {
    dir: "long", margin: MARGIN, lev: LEV,
    entry: curPrice, entryTime: now,
    qty: isOption ? MARGIN * LEV / curPrice : MARGIN * LEV / curPrice,
    pnl: 0, pnlPct: 0,
  };
  shortPos = {
    dir: "short", margin: MARGIN, lev: LEV,
    entry: curPrice, entryTime: now,
    qty: MARGIN * LEV / curPrice,
    pnl: 0, pnlPct: 0,
  };
  priceHistory = [{ ts: now, price: curPrice }];
  renderPositions();
  addRecord("🔄 自动开仓", curInst, `多空各${MARGIN}U×${LEV}x @${fmtP(curPrice)}`);
}

function onInstrumentChange() {
  // 更新卡片高亮
  document.querySelectorAll(".bt-ic").forEach(el =>
    el.classList.toggle("active", el.dataset.inst === curInst));
  // 切换品种 → 重置并自动开仓
  candles = []; trades = []; priceHistory = [];
  longPos = shortPos = null;
  renderAll();
  loadChart();
  loadTrades();
  fetchPrice().then(() => autoOpen()).catch(() => {});
  startTick();
}

// ---- 行情 ----
async function fetchPrice() {
  if (!curInst) return;
  try {
    const t = await okx(`/market/ticker?instId=${curInst}`);
    if (t && t[0]) {
      curPrice = +t[0].last;
      priceHistory.push({ ts: Date.now(), price: curPrice });
      if (priceHistory.length > 600) priceHistory.shift();  // 保留~50分钟
    }
    B$("btDot").className = "bt-dot bt-ok";
    B$("btLast").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false })
      + (usingFallback ? " (币安兜底)" : " OKX");
  } catch (e) {
    B$("btDot").className = "bt-dot bt-err";
    B$("btLast").textContent = "数据不可达";
  }
}

function startTick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(async () => {
    await fetchPrice();
    updatePositions();
  }, 5000);
}

// ---- 盈亏计算 ----
function updatePositions() {
  if (curPrice <= 0) return;
  const now = Date.now();
  for (const pos of [longPos, shortPos]) {
    if (!pos) continue;
    const isLong = pos.dir === "long";
    const priceChg = isLong ? (curPrice / pos.entry - 1) : (1 - curPrice / pos.entry);
    pos.pnl = pos.margin * pos.lev * priceChg;
    pos.pnlPct = priceChg * pos.lev * 100;
    // 亏损速度: 取最近60秒的价格变化
    const recent = priceHistory.filter(p => now - p.ts <= 60000);
    if (recent.length >= 2) {
      const oldest = recent[0], newest = recent[recent.length - 1];
      const chg = isLong ? (newest.price / oldest.price - 1) : (1 - newest.price / oldest.price);
      pos.speed = pos.margin * pos.lev * chg;   // 每分钟盈亏 USDT
    } else pos.speed = 0;
  }
  renderPositions();
}

// ---- 渲染 ----
function renderPositions() {
  const sides = [["btLong", longPos], ["btShort", shortPos]];
  for (const [prefix, pos] of sides) {
    const pnlEl = B$(prefix + "Pnl"), fillEl = B$(prefix + "Fill"), labelEl = B$(prefix + "Label");
    const speedEl = B$(prefix + "Speed"), entryEl = B$(prefix + "Entry"), detailEl = B$(prefix + "Detail");
    if (!pos || !pnlEl) continue;
    // 盈亏
    pnlEl.textContent = fmtU(pos.pnl);
    pnlEl.className = "bt-pnl " + clsPnL(pos.pnl);
    // 入场
    entryEl.innerHTML = `${curInst || "--"}<br>入场 <b>${fmtP(pos.entry)}</b> → 现价 <b>${fmtP(curPrice)}</b>`;
    // 资金条
    const remaining = Math.max(0, pos.margin + pos.pnl);
    const pct = Math.max(0, Math.min(100, remaining / pos.margin * 100));
    fillEl.style.width = pct + "%";
    fillEl.className = "bt-fundbar-fill" + (pos.dir === "short" ? " short" : "") + (pct < 50 ? " danger" : pct < 80 ? " warn" : "");
    labelEl.textContent = `$${remaining.toFixed(2)} / ${pct.toFixed(1)}%`;
    // 速度
    const spd = pos.speed || 0;
    speedEl.textContent = spd === 0 ? "-- /分钟" : `${spd > 0 ? "+" : ""}$${Math.abs(spd).toFixed(2)} /分钟`;
    speedEl.className = "bt-speed " + clsPnL(spd);
    // 详情
    const lev = pos.lev;
    detailEl.innerHTML = `
      <div>仓位: $${(pos.margin * lev).toLocaleString()}</div>
      <div>数量: ${pos.qty < 1 ? pos.qty.toFixed(6) : pos.qty.toFixed(3)}</div>
      <div>杠杆: ${lev}x</div>
      <div>价格变动: ${(((curPrice / pos.entry) - 1) * 100).toFixed(3)}%</div>
      <div>持仓: ${Math.round((Date.now() - pos.entryTime) / 1000)}秒</div>`;
  }
  // 总资金条
  const total = (longPos ? longPos.margin + longPos.pnl : 0) + (shortPos ? shortPos.margin + shortPos.pnl : 0);
  const totalPct = Math.max(0, Math.min(100, total / 200 * 100));
  B$("btTotalVal").textContent = `$${total.toFixed(2)}`;
  B$("btTotalFill").style.width = totalPct + "%";
  B$("btTotalFill").className = "bt-total-fill" + (totalPct < 50 ? " danger" : totalPct < 80 ? " warn" : "");
}

// ---- K线 ----
async function loadChart() {
  if (!curInst) return;
  try {
    const data = await okx(`/market/candles?instId=${curInst}&bar=1H&limit=120`);
    candles = data.map(k => ({ ts: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], vol: +k[5] })).reverse();
    renderChart();
  } catch (e) { B$("btChart").innerHTML = `<span class="bt-loading">K线加载失败</span>`; }
}

function renderChart() {
  if (candles.length < 5) return;
  const W = 480, H = 180, PL = 10, PR = 10, PT = 10, PB = 18;
  const cw = W - PL - PR, chh = H - PT - PB;
  const closes = candles.map(k => k.c);
  const hi = Math.max(...closes), lo = Math.min(...closes);
  const range = hi - lo || 1;
  const x = i => PL + i / (closes.length - 1) * cw;
  const y = p => PT + (1 - (p - lo) / range) * chh;
  const chg = closes[closes.length - 1] / closes[0] - 1;
  const lc = chg >= 0 ? "#e54545" : "#24b28c";
  const pts = closes.map((c, i) => `${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(" ");
  // 网格
  let grid = "";
  for (let g = 0; g <= 3; g++) {
    const yy = PT + chh * g / 3;
    grid += `<line x1="${PL}" y1="${yy}" x2="${W-PR}" y2="${yy}" stroke="#232a3a" stroke-width="0.5"/>`;
  }
  const n = closes.length;
  for (let g = 0; g <= 4; g++) {
    const xx = PL + cw * g / 4;
    grid += `<line x1="${xx}" y1="${PT}" x2="${xx}" y2="${H-PB}" stroke="#232a3a" stroke-width="0.5"/>`;
  }
  B$("btChart").innerHTML = `<svg viewBox="0 0 ${W} ${H}">${grid}
    <polygon points="${PL},${H-PB} ${pts} ${x(n-1)},${H-PB}" fill="${lc}" opacity="0.06"/>
    <polyline points="${pts}" fill="none" stroke="${lc}" stroke-width="1.5"/>
    <circle cx="${x(n-1)}" cy="${y(curPrice || closes[n-1])}" r="2.5" fill="${lc}"/>
    <text x="${W-PR}" y="12" text-anchor="end" font-size="10" fill="${lc}" font-weight="700">${(chg*100).toFixed(2)}%</text>
    <text x="${PL}" y="${H-6}" font-size="8" fill="#7a8299">${new Date(candles[0].ts).toLocaleDateString("zh-CN",{month:"short",day:"numeric"})}</text>
    <text x="${W-PR}" y="${H-6}" text-anchor="end" font-size="8" fill="#7a8299">${new Date(candles[n-1].ts).toLocaleDateString("zh-CN",{month:"short",day:"numeric"})}</text>
  </svg>`;
  B$("btChartNote").textContent = `${candles.length}根 · ${curInst}`;
}

// ---- 逐笔 ----
async function loadTrades() {
  if (!curInst) return;
  try {
    const data = await okx(`/market/trades?instId=${curInst}&limit=20`);
    trades = data;
    renderTrades();
  } catch (e) { B$("btTrades").innerHTML = `<span class="bt-loading">成交加载失败</span>`; }
}

function renderTrades() {
  if (!trades.length) return;
  let buyVol = 0, sellVol = 0;
  const rows = trades.slice(0, 15).map(t => {
    const isBuy = t.side === "buy";
    const usd = +t.px * +t.sz;
    if (isBuy) buyVol += usd; else sellVol += usd;
    return `<div class="bt-trade-row">
      <span class="bt-trade-time">${new Date(+t.ts).toLocaleTimeString("zh-CN",{hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span>
      <span class="bt-trade-px ${isBuy ? "bt-green" : "bt-red"}">${fmtP(+t.px)}</span>
      <span class="bt-trade-sz">${(+t.sz).toFixed(4)}</span>
      <span class="bt-trade-side ${isBuy ? "bt-green" : "bt-red"}">${isBuy ? "🟢买" : "🔴卖"}</span>
    </div>`;
  }).join("");
  B$("btTrades").innerHTML = rows;
  const total = buyVol + sellVol;
  B$("btVolStats").innerHTML = `
    <div class="bt-vol-row"><span>主动买</span><b class="bt-green">$${(buyVol/1000).toFixed(1)}K (${total ? (buyVol/total*100).toFixed(0) : 0}%)</b></div>
    <div class="bt-vol-row"><span>主动卖</span><b class="bt-red">$${(sellVol/1000).toFixed(1)}K (${total ? (sellVol/total*100).toFixed(0) : 0}%)</b></div>`;
  B$("btVolNote").textContent = `最近${trades.length}笔 · ${curInst}`;
}

// ---- 手动开仓 ----
B$("btManualLong").addEventListener("click", () => manualOpen("long"));
B$("btManualShort").addEventListener("click", () => manualOpen("short"));

function manualOpen(dir) {
  if (!curInst || curPrice <= 0) { alert("品种未就绪"); return; }
  const m = Math.max(10, +B$("btManualAmount").value || 100);
  const lev = Math.min(125, Math.max(1, +B$("btManualLev").value || 10));
  // 记录但不替换自动仓, 只记到记录里
  const pnl = 0;  // 手动仓实时计算需要额外状态, v1只记录
  addRecord(`${dir === "long" ? "📈" : "📉"} 手动${dir === "long" ? "多" : "空"}`, curInst,
    `${m}U×${lev}x @${fmtP(curPrice)}`);
  alert(`已记录: ${dir === "long" ? "做多" : "做空"} ${curInst} ${m}U×${lev}x @${fmtP(curPrice)}\n(手动仓盈亏请在持仓区跟踪自动仓的浮盈来感受)`);
}

// ---- 记录 ----
function loadRecords() { try { records = JSON.parse(localStorage.getItem(RECORD_KEY)) || []; } catch(e) { records = []; } renderRecords(); }
function addRecord(type, inst, detail) {
  records.unshift({ t: Date.now(), type, inst, detail });
  if (records.length > 100) records.pop();
  localStorage.setItem(RECORD_KEY, JSON.stringify(records));
  renderRecords();
}
function renderRecords() {
  if (!records.length) { B$("btRecordList").innerHTML = "<span class='bt-loading'>暂无记录</span>"; return; }
  B$("btRecordList").innerHTML = records.slice(0, 20).map(r =>
    `<div class="bt-rec-row">
      <span class="bt-rec-time">${new Date(r.t).toLocaleTimeString("zh-CN",{hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</span>
      <span class="bt-rec-type">${r.type}</span>
      <span class="bt-rec-inst">${r.inst}</span>
      <span class="bt-rec-detail">${r.detail}</span>
    </div>`).join("");
}

// ---- 渲染总 ----
function renderAll() {
  renderPositions();
  if (candles.length) renderChart();
  if (trades.length) renderTrades();
}

// ---- 事件 ----
document.querySelectorAll(".bt-tab").forEach(btn =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".bt-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    productType = btn.dataset.pt;
    futureList = []; optionList = [];  // 重置缓存
    loadInstruments();
  }));

// ---- 定时刷新 ----
function startTimer() {
  clearInterval(timer);
  timer = setInterval(() => { loadChart(); loadTrades(); }, 60000);
}

// ---- 启动 ----
(async function init() {
  loadRecords();
  await loadInstruments();
  startTimer();
})();
