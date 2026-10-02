const axios=require("axios");

const SOURCES={
  coinbase:{
    name:"Coinbase",
    base:"https://api.exchange.coinbase.com",
    assets:{BTCUSD:"BTC-USD",ETHUSD:"ETH-USD"}
  },
  kraken:{
    name:"Kraken",
    base:"https://api.kraken.com/0/public",
    assets:{BTCUSD:"XBTUSD",ETHUSD:"ETHUSD"}
  }
};

const TF={
  "5m":{minutes:5,seconds:300,stale:720},
  "15m":{minutes:15,seconds:900,stale:1500},
  "1h":{minutes:60,seconds:3600,stale:5400}
};

const cache=new Map(),inflight=new Map(),quoteCache=new Map(),quoteInflight=new Map();
const CACHE_MS=5000,QUOTE_CACHE_MS=3000,TIMEOUT_MS=6000;

function finite(v){return Number.isFinite(Number(v))}
function clean(a){
  return a.filter(c=>[c.open,c.high,c.low,c.close].every(finite)&&c.open>0&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)&&c.high>=c.low)
    .sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp))
    .filter((c,i,s)=>i===0||c.timestamp!==s[i-1].timestamp);
}
async function request(url,params={}){
  return axios.get(url,{params,timeout:TIMEOUT_MS,headers:{Accept:"application/json","User-Agent":"RB-Crypto-Sniper/2.1"}});
}

async function coinbaseQuote(asset){
  const product=SOURCES.coinbase.assets[asset];
  const r=await request(SOURCES.coinbase.base+"/products/"+product+"/ticker");
  const d=r.data||{};
  return {price:Number(d.price),time:d.time||null,volume:Number(d.volume)};
}
async function krakenQuote(asset){
  const pair=SOURCES.kraken.assets[asset];
  const r=await request(SOURCES.kraken.base+"/Ticker",{pair});
  const d=r.data||{},key=Object.keys(d)[0],q=key?d[key]:{};
  const ts=q?.t?Number(q.t[0]):Date.now()/1000;
  return {price:Number(q?.c?.[0]),time:new Date(ts*1000).toISOString(),volume:Number(q?.v?.[1]||q?.v?.[0]||0)};
}
async function getQuote(source,asset){
  const key=source+":"+asset;
  if(quoteCache.has(key)&&Date.now()-quoteCache.get(key).t<QUOTE_CACHE_MS)return quoteCache.get(key).v;
  if(quoteInflight.has(key))return quoteInflight.get(key);
  const p=(source==="coinbase"?coinbaseQuote(asset):krakenQuote(asset)).then(v=>{
    quoteCache.set(key,{t:Date.now(),v});quoteInflight.delete(key);return v;
  }).catch(e=>{quoteInflight.delete(key);throw e});
  quoteInflight.set(key,p);return p;
}

function normalizeCoinbase(rows,cfg){
  return clean(rows.map(b=>{
    const ts=Number(b[0])*1000, interval=cfg.seconds*1000;
    return {timestamp:new Date(ts).toISOString(),open:Number(b[3]),high:Number(b[2]),low:Number(b[1]),close:Number(b[4]),volume:Number(b[5]||0),complete:Date.now()>=ts+interval+5000,isOpen:Date.now()<ts+interval+5000};
  }));
}
function normalizeKraken(rows,cfg){
  return clean(rows.map(b=>{
    const ts=Number(b[0])*1000, interval=cfg.seconds*1000;
    return {timestamp:new Date(ts).toISOString(),open:Number(b[1]),high:Number(b[2]),low:Number(b[3]),close:Number(b[4]),volume:Number(b[6]||0),complete:Date.now()>=ts+interval+5000,isOpen:Date.now()<ts+interval+5000};
  }));
}

async function fetchFromSource(source,asset,timeframe,requestedLimit){
  const cfg=TF[timeframe];
  if(!cfg)throw new Error("Timeframe inválido: "+timeframe);
  const limit=Math.min(300,Math.max(60,Number(requestedLimit)||300));
  const meta=SOURCES[source];
  const [cr,tick]=await Promise.all([
    source==="coinbase"
      ? request(meta.base+"/products/"+meta.assets[asset]+"/candles",{granularity:cfg.seconds})
      : request(meta.base+"/OHLC",{pair:meta.assets[asset],interval:cfg.minutes}),
    getQuote(source,asset)
  ]);
  let candles=source==="coinbase"?normalizeCoinbase(cr.data||[],cfg):normalizeKraken(cr.data?.result?.[Object.keys(cr.data?.result||{}).find(k=>k!=="last")]||[],cfg);
  candles=candles.slice(-limit);
  if(candles.length<50)throw new Error(meta.name+" devolveu poucos candles ("+candles.length+")");
  const last=candles[candles.length-1];
  const lastTs=Date.parse(last.timestamp);
  const age=Number.isFinite(lastTs)?Math.max(0,Math.round((Date.now()-lastTs)/1000)):Infinity;
  const price=finite(tick.price)?Number(tick.price):Number(last.close);
  const quoteTime=tick.time?Date.parse(tick.time):NaN;
  const quoteAge=Number.isFinite(quoteTime)?Math.max(0,Math.round((Date.now()-quoteTime)/1000)):null;
  const stale=age>cfg.stale||(Number.isFinite(quoteAge)&&quoteAge>30)||!finite(price);
  if(stale)throw new Error(meta.name+" feed atrasado: candle "+age+"s, cotação "+(quoteAge??"—")+"s");
  return {
    success:true,source:meta.name+" "+meta.assets[asset],provider:source,symbol:asset,
    displaySymbol:(source==="coinbase"?"COINBASE:":"KRAKEN:")+asset,timeframe,candles,last,price,
    delayedBy:age,candleTimestamp:last.timestamp,quoteTimestamp:tick.time||last.timestamp,
    candleAgeSec:age,candleStartAgeSec:age,quoteAgeSec:quoteAge,stale:false,
    marketState:"open",realOpenBar:last.isOpen===true,
    feedNotice:"Feed automático "+meta.name+" • troca para Kraken quando Coinbase falha ou fica atrasada"
  };
}

async function fetchCandles(asset,timeframe,requestedLimit=300){
  const order=["coinbase","kraken"];
  let lastError=null;
  for(const source of order){
    try{return await fetchFromSource(source,asset,timeframe,requestedLimit)}
    catch(e){lastError=e}
  }
  throw new Error("Coinbase e Kraken indisponíveis/atrasados: "+(lastError?.message||"erro desconhecido"));
}

async function getMarket(asset,timeframe,requestedLimit=300){
  if(!SOURCES.coinbase.assets[asset])throw new Error("Ativo inválido");
  if(!TF[timeframe])throw new Error("M1 removido: use 5m, 15m ou 1h");
  const limit=Math.min(300,Math.max(60,Number(requestedLimit)||300)),key=asset+":"+timeframe+":"+limit;
  const hit=cache.get(key);
  if(hit&&Date.now()-hit.t<CACHE_MS)return hit.v;
  if(inflight.has(key))return inflight.get(key);
  const p=fetchCandles(asset,timeframe,limit).then(v=>{cache.set(key,{t:Date.now(),v});inflight.delete(key);return v})
    .catch(e=>{inflight.delete(key);throw e});
  inflight.set(key,p);return p;
}

async function handler(req,res){
  res.setHeader("Cache-Control","no-store,max-age=0");
  try{
    const asset=String(req.query.asset||"BTCUSD").toUpperCase();
    const timeframe=String(req.query.timeframe||"5m");
    const limit=Math.min(300,Math.max(60,Number(req.query.limit)||300));
    res.status(200).json(await getMarket(asset,timeframe,limit));
  }catch(e){
    console.error("CRYPTO MARKET ERROR",e.message);
    res.status(502).json({success:false,error:"Falha no feed de mercado cripto",details:e.message,source:"Coinbase → Kraken fallback"});
  }
}
handler.getMarket=getMarket;
module.exports=handler;