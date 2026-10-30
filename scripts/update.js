// 자산 모니터 공개판: 시세 자료를 받아 data/*.json 으로 저장한다.
// GitHub Actions가 한 시간마다 이 파일을 돌린다(.github/workflows/update.yml). 노트북에서 돌려도 똑같이 된다: node scripts/update.js
//   data/history.json  주식·금·비트코인·코스피·환율 일별 기록 (하루 한 번만 새로)
//   data/apt.json      서울 아파트 KB 매매가격지수·㎡당 평균가 (하루 한 번만 새로)
//   data/live.json     지금 시세 (돌릴 때마다)
// 받는 방법은 노트북 프로그램(자산모니터/server.js)과 같다. 한쪽을 고치면 다른 쪽도 같이 고칠 것.
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };
const ASSETS = [
  { id: 'VOO', name: 'VOO', desc: '미국 S&P 500', yahoo: 'VOO', join: 'SPY', cur: 'USD', basis: '배당 재투자' },
  { id: 'SCHD', name: 'SCHD', desc: '미국 배당성장주', yahoo: 'SCHD', cur: 'USD', basis: '배당 재투자' },
  { id: 'QQQ', name: 'QQQ', desc: '나스닥 100', yahoo: 'QQQ', cur: 'USD', basis: '배당 재투자' },
  { id: 'GLD', name: 'GLD', desc: '금', yahoo: 'GLD', cur: 'USD', basis: '금 가격' },
  { id: 'BTC', name: '비트코인', desc: 'BTC', yahoo: 'BTC-USD', cur: 'USD', basis: '달러 가격', h24: true },
  { id: 'KOSPI', name: '코스피', desc: '한국 종합주가지수', yahoo: '^KS11', cur: 'PT', basis: '지수(배당 제외)' },
  { id: 'FX', name: '원/달러 환율', desc: '1달러 = 원', yahoo: 'KRW=X', cur: 'RATE', basis: '환율', clean: true },
];
const SEOUL = '11';
const FORCE = process.argv.includes('--force'); // 손으로 돌릴 때(Actions의 Run workflow)는 오늘 받은 것도 다시 받음

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const writeJson = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); };
const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function getJson(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`);
  return r.json();
}
async function yahoo(q) {
  try { return await getJson('https://query1.finance.yahoo.com' + q); }
  catch (e) { return getJson('https://query2.finance.yahoo.com' + q); }
}

// ── 일별 기록 (d = 1970-01-01부터 날 수, v = 배당 재투자 수정 종가) ──
async function yahooDaily(sym) {
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?period1=0&period2=${p2}&interval=1d&events=div%2Csplit`);
  const r = j.chart.result[0], off = r.meta.gmtoffset || 0, ts = r.timestamp || [];
  const adj = (r.indicators.adjclose && r.indicators.adjclose[0].adjclose) || r.indicators.quote[0].close;
  const d = [], v = [];
  for (let i = 0; i < ts.length; i++) {
    const x = adj[i];
    if (x == null || !(x > 0)) continue;
    const day = Math.floor((ts[i] + off) / 86400), val = +x.toPrecision(7);
    if (d.length && d[d.length - 1] >= day) { if (d[d.length - 1] === day) v[v.length - 1] = val; continue; }
    d.push(day); v.push(val);
  }
  return { d, v };
}
// 앞뒤 날은 비슷한데 그날만 2.5% 넘게 튄 값 → 앞뒤 평균으로 (환율 기록의 잘못 찍힌 값)
function dropSpikes(s) {
  const v = s.v.slice();
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 1; i < v.length - 1; i++) {
      const a = v[i - 1], b = v[i], c = v[i + 1];
      if (Math.abs(c / a - 1) < 0.015 && Math.abs(b / a - 1) > 0.025 && Math.abs(b / c - 1) > 0.025 && Math.sign(b - a) === Math.sign(b - c)) { v[i] = +((a + c) / 2).toPrecision(7); changed = true; }
    }
    if (!changed) break;
  }
  return { d: s.d, v };
}
async function history() {
  const file = path.join(DATA, 'history.json'), old = readJson(file);
  if (!FORCE && old && old.fetched === todayKst() && old.assets.every((a) => a.d && a.d.length)) { console.log('일별 기록: 오늘 이미 받음'); return; }
  const errors = {}, list = [];
  for (const a of ASSETS) {
    let rec = null;
    try {
      let s = await yahooDaily(a.yahoo);
      if (a.clean) s = dropSpikes(s);
      let joined = null;
      if (a.join) {
        const b = await yahooDaily(a.join), k = b.d.indexOf(s.d[0]);
        if (k > 0) {
          const f = s.v[0] / b.v[k];
          joined = { from: b.d[0], to: s.d[0], sym: a.join };
          s = { d: b.d.slice(0, k).concat(s.d), v: b.v.slice(0, k).map((x) => +(x * f).toPrecision(7)).concat(s.v) };
        }
      }
      if (s.d.length < 200) throw new Error('기록이 너무 짧음 ' + s.d.length);
      rec = { ...s, joined };
    } catch (e) {
      errors[a.id] = String(e.message || e);
      const prev = old && old.assets.find((x) => x.id === a.id);
      if (prev && prev.d) rec = { d: prev.d, v: prev.v, joined: prev.joined || null };
    }
    list.push({ id: a.id, name: a.name, desc: a.desc, cur: a.cur, basis: a.basis, h24: !!a.h24, ...(rec || {}) });
  }
  if (Object.keys(errors).length === ASSETS.length && old) { console.log('일별 기록: 모두 실패, 지난 기록 그대로', errors); return; }
  writeJson(file, { assets: list, fetched: todayKst(), at: Date.now(), errors });
  console.log('일별 기록 저장', Object.keys(errors).length ? errors : '');
}

// ── 지금 시세 ──
async function live() {
  const q = {}, errors = {}, now = Date.now() / 1000;
  const syms = ASSETS.filter((a) => a.id !== 'KOSPI').map((a) => a.yahoo);
  await Promise.all([
    yahoo(`/v7/finance/spark?symbols=${syms.map(encodeURIComponent).join(',')}&range=1d&interval=1d`).then((j) => {
      for (const it of j.spark.result) {
        const m = it.response && it.response[0] && it.response[0].meta;
        if (!m || !m.regularMarketPrice) continue;
        const reg = m.currentTradingPeriod && m.currentTradingPeriod.regular, a = ASSETS.find((x) => x.yahoo === it.symbol);
        q[a ? a.id : it.symbol] = {
          p: m.regularMarketPrice, prev: m.chartPreviousClose, t: m.regularMarketTime * 1000,
          day: Math.floor((m.regularMarketTime + (m.gmtoffset || 0)) / 86400),
          open: (a && a.h24) || !!(reg && now >= reg.start && now < reg.end), tz: m.exchangeTimezoneName,
        };
      }
    }).catch((e) => { errors.yahoo = String(e.message || e); }),
    getJson('https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI').then((j) => {
      const x = j.datas[0];
      const p = parseFloat(x.closePriceRaw || String(x.closePrice).replace(/,/g, ''));
      const ch = parseFloat(x.compareToPreviousClosePriceRaw || String(x.compareToPreviousClosePrice).replace(/,/g, ''));
      const ds = String(x.localTradedAt || '').slice(0, 10).split('-').map(Number);
      q.KOSPI = { p, prev: +(p - ch).toFixed(2), t: Date.parse(x.localTradedAt), day: Date.UTC(ds[0], ds[1] - 1, ds[2]) / 86400e3, open: x.marketStatus === 'OPEN', tz: 'Asia/Seoul' };
    }).catch((e) => { errors.naver = String(e.message || e); }),
    getJson('https://api.upbit.com/v1/ticker?markets=KRW-BTC').then((j) => {
      q.UPBIT = { p: j[0].trade_price, prev: j[0].prev_closing_price, t: j[0].trade_timestamp };
    }).catch((e) => { errors.upbit = String(e.message || e); }),
  ]);
  const file = path.join(DATA, 'live.json'), old = readJson(file);
  if (!Object.keys(q).length && old) { console.log('지금 시세: 모두 실패, 지난 시세 그대로', errors); return; }
  // 받지 못한 종목은 지난 시세로 채운다
  if (old && old.q) for (const k of Object.keys(old.q)) if (!q[k]) q[k] = old.q[k];
  writeJson(file, { at: Date.now(), q, errors });
  console.log('지금 시세 저장', Object.keys(errors).length ? errors : '');
}

// ── 서울 아파트 (KB부동산 주택가격동향) ──
async function kb(name, params) {
  const j = await getJson('https://data-api.kbland.kr/bfmstat/weekMnthlyHuseTrnd/' + name + '?' + new URLSearchParams(params));
  const d = j.dataBody && j.dataBody.data;
  if (!d || !d.날짜리스트) throw new Error(`KB ${name} 응답 이상`);
  const n = d.날짜리스트.length;
  return { dates: d.날짜리스트, rows: d.데이터리스트.map((x) => ({ code: x.지역코드, name: x.지역명, v: x.dataList.slice(0, n).map((y) => (y == null ? null : +Number(y).toPrecision(7))) })) };
}
async function apt() {
  const file = path.join(DATA, 'apt.json'), old = readJson(file);
  if (!FORCE && old && old.fetched === todayKst()) { console.log('아파트: 오늘 이미 받음'); return; }
  try {
    const base = { 매물종별구분: '01', 매매전세코드: '01' };
    const [monthly, weekly, sqm, avg] = await Promise.all([
      kb('priceIndex', { 월간주간구분코드: '01', ...base, 지역코드: SEOUL, 기간: '50' }),
      kb('priceIndex', { 월간주간구분코드: '02', ...base, 지역코드: SEOUL, 기간: '2' }),
      kb('avgPrcPerSqmt', { ...base, 지역코드: SEOUL, 기간: '50' }),
      kb('avgPrc', { ...base, 기간: '50' }),
    ]);
    const seoulOnly = (t) => ({ dates: t.dates, rows: t.rows.filter((r) => r.code.startsWith('11')) });
    const avgKeep = { dates: avg.dates, rows: avg.rows.filter((r) => ['1100000000', '1A0000', '1B0000'].includes(r.code)) };
    writeJson(file, { fetched: todayKst(), at: Date.now(), monthly: seoulOnly(monthly), weekly: seoulOnly(weekly), sqm: seoulOnly(sqm), avg: avgKeep });
    console.log('아파트 저장');
  } catch (e) {
    console.log('아파트 실패(지난 자료 그대로):', e.message || e);
    if (!old) throw e;
  }
}

(async () => {
  await Promise.all([history(), live(), apt()]);
})().catch((e) => { console.error(e); process.exit(1); });
