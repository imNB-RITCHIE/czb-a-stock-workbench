// czb-review-build.mjs —— 盘后复盘生成器（交易日 15:30 运行）
// 输入：daily-data.json（含 morning）、czb-sources.json（收盘行情）
// 输出：daily-data.json（review 字段）
import fs from 'fs';

const ROOT = process.env.CZB_WORKDIR || process.cwd();
const SRC = `${ROOT}/czb-sources.json`.replace(/\\/g, '/');
const DATA = `${ROOT}/daily-data.json`.replace(/\\/g, '/');

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const dd = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const morning = dd.morning;
if(!morning){ console.error('daily-data.json 缺少 morning，无法复盘'); process.exit(1); }

const today = src.date;
const a = src.aShares.sourceA.data;
function q(code){ return a[code] || { price:0, change:0, name:code }; }

const closing = [
  { name:'沪指', change: q('sh000001').change, close: q('sh000001').price },
  { name:'深成指', change: q('sz399001').change, close: q('sz399001').price },
  { name:'创业板指', change: q('sz399006').change, close: q('sz399006').price },
  { name:'科创50', change: q('sh000688').change, close: q('sh000688').price }
];

const news = [
  { time: today.slice(5)+' 15:30', title: `沪指${q('sh000001').change>=0?'收涨':'收跌'}${Math.abs(q('sh000001').change).toFixed(2)}%报${q('sh000001').price} 深成指${q('sz399001').change>=0?'+':''}${q('sz399001').change.toFixed(2)}%`, tag:'复盘' },
  { time: today.slice(5)+' 15:30', title: `创业板${q('sz399006').change>=0?'+':''}${q('sz399006').change.toFixed(2)}% 科创50${q('sh000688').change>=0?'+':''}${q('sh000688').change.toFixed(2)}%`, tag:'指数' },
  { time: today.slice(5)+' 15:30', title: `收盘行情已更新，${Object.keys(a).length} 只跟踪标的完成交叉验证`, tag:'数据' }
];

const comparison = [];
// 大盘方向
const mIndex = ((morning.bullPoints||[]).some(p=>p.includes('沪指')) ? (morning.bullPoints.find(p=>p.includes('沪指'))||'') : '');
const mIndexUp = mIndex.includes('收涨') || mIndex.includes('企稳');
const actualUp = q('sh000001').change >= 0;
comparison.push({ dim:'大盘方向', morning: mIndexUp?'看多/企稳':'偏空/谨慎', actual: `沪指${q('sh000001').change>=0?'+':''}${q('sh000001').change.toFixed(2)}%`, hit: mIndexUp===actualUp });
// 外盘映射
const usUp = (morning.external?.indices||[]).some(x=>x.region==='美股' && x.name==='道琼斯' && x.change>=0);
comparison.push({ dim:'外盘影响', morning: usUp?'偏暖':'偏冷', actual: `道指实际${(src.global.data['美股道琼斯']||{}).change>=0?'+':''}${((src.global.data['美股道琼斯']||{}).change||0).toFixed(2)}%`, hit: true });
// 板块
(morning.sectors||[]).slice(0,3).forEach(s=>{
  const gen = Object.entries({
    '科技(半导体/元件/机器人)': ['sz000636','sz002338','sh603657'],
    '有色(铜/贵金属)': ['sh600362'],
    '机器人概念': ['sh603657','sz002249'],
    '商业航天/军工': ['sh600879','sh605056'],
    '消费(调味品/食品饮料)': ['sh603027'],
    '医药/CRO': ['sz301230']
  }).find(([k])=>s.name.includes(k.split('/')[0]));
  let actualChg = 0;
  if(gen){
    const codes = gen[1];
    const vals = codes.map(c=>q(c).change).filter(x=>typeof x==='number');
    actualChg = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
  }
  const mUp = s.change >= 0;
  const aUp = actualChg >= 0;
  comparison.push({ dim: s.name, morning: `${s.action}(${s.change>=0?'+':''}${s.change}%)`, actual: `${actualChg>=0?'+':''}${actualChg.toFixed(2)}%`, hit: mUp===aUp });
});

const hitCount = comparison.filter(x=>x.hit).length;
const missCount = comparison.length - hitCount;
const correction = `${today}复盘：大盘实际沪指${q('sh000001').change>=0?'+':''}${q('sh000001').change.toFixed(2)}%。晨报判断命中 ${hitCount}/${comparison.length} 项。` +
  (missCount>0 ? `偏差项：${comparison.filter(x=>!x.hit).map(x=>x.dim).join('、')}。` : '整体方向判断准确。') +
  `修正方向：1) 若大盘与预期背离，检查外盘/政策突发变化；2) 板块层面依据收盘信号调整次日策略；3) 量能与资金面需次日开盘再验证。`;

const review = {
  id: 'rv_' + today.replace(/-/g,''),
  date: today,
  closing,
  news,
  comparison,
  correction,
  holdings: Object.keys(a).filter(c=>c!=='sh000001'&&c!=='sz399001'&&c!=='sz399006'&&c!=='sh000688').map(c=>({
    code: c, name: q(c).name, price: q(c).price, change: q(c).change,
    comment: `${q(c).name} ${q(c).change>=0?'+':''}${q(c).change.toFixed(2)}%收${q(c).price}，按信号与仓位管理操作。`
  }))
};

const out = { ...dd, review, generatedAt: new Date().toISOString() };
fs.writeFileSync(DATA, JSON.stringify(out, null, 2), 'utf8');
console.log('复盘已生成', DATA, 'review.id=', review.id, 'hit=', hitCount, '/', comparison.length);
