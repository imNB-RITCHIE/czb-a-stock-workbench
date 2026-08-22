// czb-morning-build.mjs —— 盘前晨报生成器（交易日 05:30 运行）
// 输入：czb-sources.json（由 czb-fetch-sources.mjs 生成）
// 输出：daily-data.json（morning 字段），review/quotes/technicals 如有则保留
import fs from 'fs';

const ROOT = process.env.CZB_WORKDIR || process.cwd();
const SRC = `${ROOT}/czb-sources.json`.replace(/\\/g, '/');
const OUT = `${ROOT}/daily-data.json`.replace(/\\/g, '/');

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const today = src.date;
const a = src.aShares.sourceA.data;
const g = src.global.data;
const verified = src.crossValidation && src.crossValidation.verified;

function q(code){ return a[code] || { price: 0, change: 0, name: code }; }
function gq(label){ return g[label] || { price: 0, change: 0 }; }

/* 默认板块构成（代码→板块映射） */
const SECTOR_COMPONENTS = {
  '科技(半导体/元件/机器人)': ['sz000636','sz002338','sh603657'],
  '有色(铜/贵金属)': ['sh600362'],
  '机器人概念': ['sh603657','sz002249'],
  '商业航天/军工': ['sh600879','sh605056'],
  '消费(调味品/食品饮料)': ['sh603027'],
  '医药/CRO': ['sz301230']
};

function sectorAvg(codes){
  const vals = codes.map(c=>q(c).change).filter(x=>typeof x==='number');
  return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
}
function sectorLead(codes){
  const sorted = codes.map(c=>q(c)).filter(x=>x.change!=null).sort((x,y)=>y.change-x.change);
  return sorted.slice(0,2).map(s=>`${s.name}${s.change>0?'+':''}${s.change.toFixed(2)}%`).join(' / ') || '—';
}

const sectors = Object.entries(SECTOR_COMPONENTS).map(([name, codes]) => {
  const chg = sectorAvg(codes);
  const isUp = chg > 0;
  let action = '观望';
  if(chg > 2) action = '不追，持有待涨';
  else if(chg > 0.5) action = '持有';
  else if(chg < -2) action = '减仓/回避';
  else if(chg < -0.5) action = '谨慎';
  return {
    name, change: +chg.toFixed(2),
    flow: isUp ? '资金偏暖' : '资金偏冷',
    lead: sectorLead(codes),
    status: `${name} ${isUp?'上涨':'下跌'}${Math.abs(chg).toFixed(2)}%，领涨：${sectorLead(codes)}。`,
    action
  };
});

/* 外盘摘要 */
const usDow = gq('美股道琼斯').change, usNas = gq('美股纳斯达克').change, usSp = gq('美股标普500').change;
const hk = gq('港股恒生').change, hkTech = gq('港股恒生科技').change;
const nikkei = gq('日经225').change, kospi = gq('韩国KOSPI').change;
const gold = gq('黄金COMEX').change, copper = gq('铜COMEX').change, oil = gq('原油WTI').change;

const externalIndices = [
  { region:'美股', name:'道琼斯', change: usDow },
  { region:'美股', name:'纳斯达克', change: usNas },
  { region:'美股', name:'标普500', change: usSp },
  { region:'港股', name:'恒生指数', change: hk },
  { region:'港股', name:'恒生科技', change: hkTech },
  { region:'亚股', name:'日经225', change: nikkei },
  { region:'亚股', name:'韩国KOSPI', change: kospi },
  { region:'大宗', name:'黄金COMEX', change: gold },
  { region:'大宗', name:'铜COMEX', change: copper },
  { region:'大宗', name:'原油WTI', change: oil }
];

/* 综合评分：基于指数+外盘+量能占位（50 为中性） */
const indexScore = (q('sh000001').change + q('sz399001').change + q('sz399006').change) / 3;
const externalScore = (usDow + usNas + hkTech + nikkei + kospi) / 5;
const rawScore = 50 + indexScore * 1.5 + externalScore * 1.2;
const score = Math.max(0, Math.min(50, Math.round(rawScore * 10) / 10));

const bullPoints = [];
const bearPoints = [];
if(usDow >= 0) bullPoints.push(`隔夜美股收涨：道指${usDow>0?'+':''}${usDow.toFixed(2)}%、纳指${usNas>0?'+':''}${usNas.toFixed(2)}%，外盘情绪偏暖。`);
else bearPoints.push(`隔夜美股收跌：道指${usDow.toFixed(2)}%、纳指${usNas.toFixed(2)}%，对A股情绪形成压力。`);
if(gold >= 0) bullPoints.push(`黄金${gold>0?'+':''}${gold.toFixed(2)}%维持强势，央行购金+降息预期支撑贵金属。`);
else bearPoints.push(`黄金${gold.toFixed(2)}%回调，避险资产获利了结。`);
if(copper >= 0) bullPoints.push(`铜${copper>0?'+':''}${copper.toFixed(2)}%反弹，工业金属需求预期改善。`);
else bearPoints.push(`铜${copper.toFixed(2)}%走弱，关注全球制造业数据。`);
if(hkTech >= 0) bullPoints.push(`港股恒生科技${hkTech>0?'+':''}${hkTech.toFixed(2)}%反弹，中概情绪修复。`);
else bearPoints.push(`港股恒生科技${hkTech.toFixed(2)}%下跌，离岸风险偏好承压。`);
if(q('sh000001').change >= 0) bullPoints.push(`昨日沪指${q('sh000001').change>0?'+':''}${q('sh000001').change.toFixed(2)}%收${q('sh000001').price}，短线企稳。`);
else bearPoints.push(`昨日沪指${q('sh000001').change.toFixed(2)}%收${q('sh000001').price}，短线偏弱。`);

/* 多维度（占位，可由用户后续校准） */
const dims = [
  { label:'情绪', pct: Math.round(Math.min(100, Math.max(0, 50 + externalScore*2))) },
  { label:'技术', pct: Math.round(Math.min(100, Math.max(0, 50 + indexScore*2))) },
  { label:'短趋势', pct: Math.round(Math.min(100, Math.max(0, 50 + indexScore*1.8))) },
  { label:'量能', pct: 50 },
  { label:'估值', pct: 50 },
  { label:'板块轮动', pct: 50 },
  { label:'个股宽度', pct: 50 },
  { label:'风格', pct: 50 },
  { label:'中长趋势', pct: 50 }
];

const morning = {
  id: 'mr_' + today.replace(/-/g,''),
  date: today,
  score,
  summary: `${today}盘前：沪指昨${q('sh000001').change>0?'+':''}${q('sh000001').change.toFixed(2)}%报${q('sh000001').price}，深成指${q('sz399001').change>0?'+':''}${q('sz399001').change.toFixed(2)}%，创业板${q('sz399006').change>0?'+':''}${q('sz399006').change.toFixed(2)}%。隔夜美股道指${usDow>0?'+':''}${usDow.toFixed(2)}%/纳指${usNas>0?'+':''}${usNas.toFixed(2)}%；黄金${gold>0?'+':''}${gold.toFixed(2)}%、铜${copper>0?'+':''}${copper.toFixed(2)}%。综合评分${score.toFixed(1)}，建议控仓操作，严格止损。`,
  bullPoints,
  bearPoints,
  sectors,
  strategy: `【仓位建议】根据综合评分${score.toFixed(1)}，建议仓位 5-6 成，单票上限 50%，止损 -5%。\n【方向】关注科技/机器人/有色的业绩确定性方向；消费/医药等待催化；黄金/铜根据外盘节奏波段操作。\n【操作】1）持仓个股按信号操作；2）新增开仓等待回踩企稳；3）外盘若持续走弱则减仓防守。\n【风险】美股回调、地缘冲突、汇率波动、量能不足。`,
  dims,
  sectorDataVerified: verified,
  source: verified
    ? `A股交叉验证通过（腾讯+新浪）；外盘来自腾讯+东财；大宗来自新浪/Yahoo；生成于 ${src.generatedAt}`
    : `A股双源存在差异：${(src.crossValidation.issues||[]).join('；') || '未知'}；外盘来自腾讯+东财；大宗来自新浪/Yahoo`,
  external: {
    asOf: src.generatedAt,
    indices: externalIndices,
    impact: `隔夜美股道指${usDow>0?'+':''}${usDow.toFixed(2)}%、纳指${usNas>0?'+':''}${usNas.toFixed(2)}%；亚太日韩${nikkei>0?'+':''}${nikkei.toFixed(2)}%/${kospi>0?'+':''}${kospi.toFixed(2)}%；港股恒生科技${hkTech>0?'+':''}${hkTech.toFixed(2)}%。映射A股：外盘情绪${usDow>=0&&hkTech>=0?'偏暖':'分化'}，成长方向受纳指与恒生科技联动影响较大。`,
    policy: `【美联储/美债】请补充最新美债收益率、美联储加息/降息预期（数据占位）。\n【国际政策】请补充对行业板块有重大影响的国际决策（如半导体出口管制、关税、地缘事件）。\n【国内政策】请补充国内最新经济/行业政策（如降准降息、产业扶持、资本市场改革）。\n【提示】政策面为定性分析，建议结合当日财新/Wind/东财要闻手动更新。`
  }
};

let base = {};
try{ base = JSON.parse(fs.readFileSync(OUT, 'utf8')); }catch(e){}
const out = {
  ...base,
  generatedAt: new Date().toISOString(),
  source: morning.source,
  morning
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log('晨报已生成', OUT, 'score=', score, 'verified=', verified);
