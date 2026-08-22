// czb-fetch-sources.mjs —— 抓取多源行情，生成交叉验证数据源
// 用法：node czb-fetch-sources.mjs [YYYY-MM-DD]
// 输出：czb-sources.json（A股双源：腾讯+新浪；外盘：腾讯+东财；大宗：Yahoo/新浪）
import fs from 'fs';

const today = process.argv[2] || new Date().toISOString().slice(0, 10);
const ROOT = process.env.CZB_WORKDIR || process.cwd();
const OUT = `${ROOT}/czb-sources.json`.replace(/\\/g, '/');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const DEFAULT_WATCHLIST = [
  ['sh000001','沪指'],['sz399001','深成指'],['sz399006','创业板指'],['sh000688','科创50'],
  ['sh600362','江西铜业'],['sz000636','风华高科'],['sh603657','春光科技'],
  ['sh600879','航天电子'],['sh600900','长江电力'],['sz002249','大洋电机'],
  ['sz002338','奥普光电'],['sh603027','千禾味业'],['sh605056','咸亨国际'],
  ['sz301230','泓博医药']
];

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function fetchText(url, opts={}){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), 12000);
  try{
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...(opts.referer?{Referer:opts.referer}:{}) }, signal: ctrl.signal });
    if(!r.ok) throw new Error('HTTP '+r.status);
    return opts.buffer ? await r.arrayBuffer() : await r.text();
  }finally{ clearTimeout(t); }
}

/* ---------- 腾讯行情（sourceA） ---------- */
async function fetchTencent(codes){
  const batches = [];
  for(let i=0;i<codes.length;i+=100) batches.push(codes.slice(i,i+100));
  const map = {};
  for(const batch of batches){
    const url = 'https://qt.gtimg.cn/q='+batch.join(',');
    try{
      const buf = await fetchText(url, { buffer: true });
      const txt = new TextDecoder('gbk').decode(buf);
      for(const code of batch){
        const m = txt.match(new RegExp(`v_${code}="([^"]*)"`));
        if(!m) continue;
        const f = m[1].split('~');
        if(!f[3]) continue;
        map[code] = { name: f[1], price: +f[3], prevClose: f[4] ? +f[4] : null, change: f[32]!='' ? +f[32] : 0 };
      }
    }catch(e){ console.error('腾讯行情失败:', e.message); }
    if(batches.length>1) await sleep(300);
  }
  return map;
}

/* ---------- 新浪行情（sourceB） ---------- */
async function fetchSina(codes){
  const batches = [];
  for(let i=0;i<codes.length;i+=60) batches.push(codes.slice(i,i+60));
  const map = {};
  for(const batch of batches){
    const url = 'https://hq.sinajs.cn/list='+batch.join(',');
    try{
      const buf = await fetchText(url, { buffer: true, referer: 'https://finance.sina.com.cn/' });
      const txt = new TextDecoder('gbk').decode(buf);
      for(const code of batch){
        const m = txt.match(new RegExp(`var hq_str_${code}="([^"]*)"`));
        if(!m || !m[1]) continue;
        const f = m[1].split(',');
        // A股字段：0名称 1今日开盘 2昨日收盘 3当前价 ... 8成交量 9成交额 ...
        // 指数字段：0名称 1今日开盘 2昨日收盘 3当前点 4今日最高 ...
        const price = +f[3];
        const prev = +f[2];
        const change = prev ? ((price-prev)/prev*100) : 0;
        map[code] = { name: f[0], price, prevClose: prev, change: +change.toFixed(2) };
      }
    }catch(e){ console.error('新浪行情失败:', e.message); }
    if(batches.length>1) await sleep(300);
  }
  return map;
}

/* ---------- Yahoo 全球行情（sourceG） ---------- */
async function fetchYahoo(symbols){
  const map = {};
  for(const sym of symbols){
    try{
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
      const txt = await fetchText(url);
      const data = JSON.parse(txt);
      const meta = data.chart.result[0].meta;
      const price = meta.regularMarketPrice;
      const prev = meta.previousClose || meta.chartPreviousClose;
      const change = prev ? ((price-prev)/prev*100) : 0;
      map[sym] = { price, prevClose: prev, change: +change.toFixed(2) };
    }catch(e){ /* Yahoo 在部分网络环境不可达，静默失败 */ }
    await sleep(200);
  }
  return map;
}

/* ---------- 新浪期货（大宗兜底） ---------- */
async function fetchSinaFutures(list){
  // list: [{ label, sinaCode, yahooSymbol }]
  const map = {};
  const codes = list.map(x=>x.sinaCode).join(',');
  try{
    const buf = await fetchText('https://hq.sinajs.cn/list='+codes, { buffer: true, referer: 'https://finance.sina.com.cn/' });
    const txt = new TextDecoder('gbk').decode(buf);
    for(const item of list){
      const m = txt.match(new RegExp(`var hq_str_${item.sinaCode}="([^"]*)"`));
      if(!m || !m[1]) continue;
      const f = m[1].split(',');
      const price = +f[0]; const prev = +f[7];
      map[item.yahooSymbol] = { name: f[13] || item.label, price, prevClose: prev, change: prev ? +(((price-prev)/prev*100).toFixed(2)) : 0 };
    }
  }catch(e){ console.error('新浪期货失败:', e.message); }
  return map;
}

/* ---------- 东方财富全球指数（补充亚股、标普） ---------- */
async function fetchEMGlobal(secids){
  const map = {};
  const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f13,f14,f2,f3,f4,f152&secids=' + secids.join(',');
  try{
    const txt = await fetchText(url);
    const data = JSON.parse(txt);
    const arr = (data.data && data.data.diff) || [];
    for(const item of arr){
      const secid = item.f13 + '.' + item.f12;
      map[secid] = { name: item.f14, price: item.f2, change: item.f3 };
    }
  }catch(e){ console.error('东财全球指数失败:', e.message); }
  return map;
}

/* ---------- 交叉验证 ---------- */
function crossValidate(aMap, bMap){
  const issues = [];
  let verified = true;
  for(const code of Object.keys(aMap)){
    const a = aMap[code], b = bMap[code];
    if(!b) continue;
    if(a.price && b.price){
      const priceDiff = Math.abs(a.price - b.price);
      const priceDiffPct = a.price ? priceDiff / a.price * 100 : 0;
      if(priceDiffPct > 0.5){
        issues.push(`${code} 价格差异 ${priceDiffPct.toFixed(2)}% (腾讯${a.price}/新浪${b.price})`);
        verified = false;
      }
    }
    if(typeof a.change==='number' && typeof b.change==='number'){
      const changeDiff = Math.abs(a.change - b.change);
      if(changeDiff > 0.3){
        issues.push(`${code} 涨跌幅差异 ${changeDiff.toFixed(2)}% (腾讯${a.change}%/新浪${b.change}%)`);
        verified = false;
      }
    }
  }
  return { verified, issues };
}

/* ---------- 主流程 ---------- */
const codes = DEFAULT_WATCHLIST.map(x=>x[0]);
const names = Object.fromEntries(DEFAULT_WATCHLIST);

console.log('['+today+'] 开始抓取行情...');
const [tencent, sina] = await Promise.all([fetchTencent(codes), fetchSina(codes)]);
console.log('A股 腾讯:', Object.keys(tencent).length, '新浪:', Object.keys(sina).length);

const globalTencentSymbols = {
  '美股道琼斯': 'usDJI', '美股纳斯达克': 'usIXIC',
  '港股恒生': 'hkHSI', '港股恒生科技': 'hkHSTECH'
};
const globalEMSymbols = {
  '美股标普500': '100.SPX', '日经225': '100.N225', '韩国KOSPI': '100.KS11'
};
const commodityList = [
  { label: '黄金COMEX', sinaCode: 'hf_GC', yahooSymbol: 'GC=F' },
  { label: '铜COMEX', sinaCode: 'hf_HG', yahooSymbol: 'HG=F' },
  { label: '原油WTI', sinaCode: 'hf_CL', yahooSymbol: 'CL=F' }
];
const commoditySymbols = Object.fromEntries(commodityList.map(x=>[x.label, x.yahooSymbol]));

const tencentGlobal = await fetchTencent(Object.values(globalTencentSymbols));
const emGlobal = await fetchEMGlobal(Object.values(globalEMSymbols));
const yahooCommodities = await fetchYahoo(commodityList.map(x=>x.yahooSymbol));
const sinaCommodities = await fetchSinaFutures(commodityList);

// 按名称整理 global：美股/港股用腾讯，亚股/标普用东财，大宗优先 Yahoo、新浪兜底
const globalNamed = {};
for(const [label, code] of Object.entries(globalTencentSymbols)){
  const t = tencentGlobal[code];
  globalNamed[label] = t ? { price: t.price, prevClose: t.prevClose, change: t.change } : null;
}
for(const [label, secid] of Object.entries(globalEMSymbols)){
  globalNamed[label] = emGlobal[secid] || null;
}
for(const [label, sym] of Object.entries(commoditySymbols)){
  globalNamed[label] = yahooCommodities[sym] || sinaCommodities[sym] || null;
}

const validation = crossValidate(tencent, sina);

const output = {
  date: today,
  generatedAt: new Date().toISOString(),
  aShares: {
    sourceA: { name: '腾讯财经 qt.gtimg.cn', data: tencent },
    sourceB: { name: '新浪财经 hq.sinajs.cn', data: sina },
    names
  },
  global: { source: '腾讯全球 + Yahoo 大宗', data: globalNamed },
  crossValidation: validation
};

fs.writeFileSync(OUT, JSON.stringify(output, null, 2), 'utf8');
console.log('已写入', OUT);
console.log('交叉验证:', validation.verified ? '通过' : '存在差异', validation.issues.length ? '\n  - '+validation.issues.join('\n  - ') : '');
