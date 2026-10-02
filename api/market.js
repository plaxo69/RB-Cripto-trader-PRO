const axios = require("axios");

const BASE="https://api.exchange.coinbase.com";
const ASSETS={
  BTCUSD:{product:"BTC-USD",display:"COINBASE:BTCUSD"},
  ETHUSD:{product:"ETH-USD",display:"COINBASE:ETHUSD"}
};
const TF={
  "1m":{granularity:60,stale:150},
  "5m":{granularity:300,stale:720},
  "15m":{granularity:900,stale:1500},
  "1h":{granularity:3600,stale:5400}
};
const cache=new Map(),inflight=new Map(),quoteCache=new Map(),quoteInflight=new Map();
const CACHE_MS=5000,QUOTE_CACHE_MS=3000,TIMEOUT_MS=6000;
function finite(v){return Number.isFinite(Number(v))}
function clean(a){return a.filter(c=>[c.open,c.high,c.low,c.close].every(finite)&&c.open>0&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)&&c.high>=c.low).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)).filter((c,i,s)=>i===0||c.timestamp!==s[i-1].timestamp)}
async function request(path,params={}){return axios.get(`${BASE}/${path}`,{params,timeout:TIMEOUT_MS,headers:{Accept:"application/json","User-Agent":"RB-Crypto-Sniper/1.0"}})}
async function getQuote(asset){
  if(quoteCache.has(asset)&&Date.now()-quoteCache.get(asset).t<QUOTE_CACHE_MS)return quoteCache.get(asset).v;
  if(quoteInflight.has(asset))return quoteInflight.get(asset);
  const product=ASSETS[asset].product;
  const p=request(`products/${product}/ticker`).then(r=>{const d=r.data||{};const v={price:Number(d.price),time:d.time||null,volume:Number(d.volume)};quoteCache.set(asset,{t:Date.now(),v});quoteInflight.delete(asset);return v}).catch(e=>{quoteInflight.delete(asset);if(quoteCache.has(asset))return quoteCache.get(asset).v;throw e});
  quoteInflight.set(asset,p);return p;
}
async function fetchCandles(asset,timeframe,requestedLimit=300){
  const cfg=TF[timeframe],meta=ASSETS[asset];
  if(!cfg)throw new Error("Timeframe inválido");
  const limit=Math.min(300,Math.max(60,Number(requestedLimit)||300));
  const [cr,tick]=await Promise.all([
    request(`products/${meta.product}/candles`,{granularity:cfg.granularity}),
    getQuote(asset)
  ]);
  if(!Array.isArray(cr.data)||!cr.data.length)throw new Error(`Coinbase não devolveu candles ${asset}`);
  const candles=clean(cr.data.slice(0,limit).map(b=>{
    const ts=Number(b[0])*1000;
    const open=Number(b[3]),high=Number(b[2]),low=Number(b[1]),close=Number(b[4]);
    const intervalMs=cfg.granularity*1000;
    const isOpen=Date.now()<ts+intervalMs+5000;
    return {timestamp:new Date(ts).toISOString(),open,high,low,close,volume:Number(b[5]||0),complete:!isOpen,isOpen};
  }));
  if(candles.length<50)throw new Error(`Coinbase devolveu poucos candles (${candles.length})`);
  const last=candles[candles.length-1],lastTs=Date.parse(last.timestamp),age=Number.isFinite(lastTs)?Math.max(0,Math.round((Date.now()-lastTs)/1000)):Infinity;
  const price=Number.isFinite(tick.price)?tick.price:last.close;
  const quoteTime=tick.time?Date.parse(tick.time):NaN;
  const quoteAge=Number.isFinite(quoteTime)?Math.max(0,Math.round((Date.now()-quoteTime)/1000)):null;
  const stale=age>cfg.stale||(Number.isFinite(quoteAge)&&quoteAge>30)||!Number.isFinite(price);
  return {success:true,source:`Coinbase ${meta.product}`,symbol:asset,displaySymbol:meta.display,timeframe,candles,last,price,delayedBy:age,candleTimestamp:last.timestamp,quoteTimestamp:tick.time||last.timestamp,candleAgeSec:age,candleStartAgeSec:age,quoteAgeSec:quoteAge,stale,marketState:"open",realOpenBar:last.isOpen===true,liveM1:timeframe==="1m"&&!stale,oandaLive:false,feedNotice:`${meta.product} OHLC + cotação ao vivo via Coinbase; TradingView mostra ${meta.display}`};
}
async function getMarket(asset,timeframe,requestedLimit=300){
  if(!ASSETS[asset])throw new Error("Ativo inválido");
  if(!TF[timeframe])throw new Error("Timeframe inválido");
  const limit=Math.min(300,Math.max(60,Number(requestedLimit)||300)),key=`coinbase:${asset}:${timeframe}:${limit}`;
  const hit=cache.get(key);if(hit&&Date.now()-hit.t<CACHE_MS)return hit.v;
  if(inflight.has(key))return inflight.get(key);
  const p=fetchCandles(asset,timeframe,limit).then(v=>{cache.set(key,{t:Date.now(),v});inflight.delete(key);return v}).catch(e=>{inflight.delete(key);const old=cache.get(key);if(old&&Date.now()-old.t<120000)return {...old.v,stale:true,liveM1:false,feedNotice:old.v.feedNotice+" • snapshot anterior após falha temporária"};throw e});
  inflight.set(key,p);return p;
}
async function handler(req,res){
  res.setHeader("Cache-Control","no-store,max-age=0");
  try{
    const asset=String(req.query.asset||"BTCUSD").toUpperCase(),timeframe=String(req.query.timeframe||"1m");
    const limit=Math.min(300,Math.max(60,Number(req.query.limit)||300));
    res.status(200).json(await getMarket(asset,timeframe,limit));
  }catch(e){console.error("CRYPTO MARKET ERROR",e.message);res.status(502).json({success:false,error:"Falha no feed de mercado cripto",details:e.message,source:"Coinbase BTC/ETH"})}
}
handler.getMarket=getMarket;module.exports=handler;