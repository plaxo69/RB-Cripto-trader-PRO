const axios=require("axios");

const PROVIDERS=[
  {name:"Kraken",base:"https://api.kraken.com",assets:{
    BTCUSD:{product:"XBTUSD",display:"KRAKEN:XBTUSD"},
    ETHUSD:{product:"ETHUSD",display:"KRAKEN:ETHUSD"}
  }},
  {name:"Coinbase",base:"https://api.exchange.coinbase.com",assets:{
    BTCUSD:{product:"BTC-USD",display:"COINBASE:BTCUSD"},
    ETHUSD:{product:"ETH-USD",display:"COINBASE:ETHUSD"}
  }}
];

const TF={
  "1m":{krakenInterval:1,coinbaseGranularity:60,maxDelay:90},
  "5m":{krakenInterval:5,coinbaseGranularity:300,maxDelay:420},
  "15m":{krakenInterval:15,coinbaseGranularity:900,maxDelay:1200},
  "1h":{krakenInterval:60,coinbaseGranularity:3600,maxDelay:4800}
};

const cache=new Map(),inflight=new Map();
const CACHE_MS=4000,TIMEOUT_MS=4500;

function finite(v){return Number.isFinite(Number(v));}
function clean(c){
  return c.filter(x=>[x.open,x.high,x.low,x.close].every(finite)&&x.open>0&&x.high>=Math.max(x.open,x.close)&&x.low<=Math.min(x.open,x.close)&&x.high>=x.low)
    .sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp))
    .filter((x,i,s)=>i===0||x.timestamp!==s[i-1].timestamp);
}
async function request(url,params={},headers={}){
  return axios.get(url,{params,timeout:TIMEOUT_MS,headers:{Accept:"application/json","User-Agent":"RB-Crypto-Sniper/2.1",...headers}});
}

async function kraken(provider,asset,timeframe,limit){
  const meta=provider.assets[asset],cfg=TF[timeframe],started=Date.now();
  const [ohlc,ticker]=await Promise.all([
    request(provider.base+"/0/public/OHLC",{pair:meta.product,interval:cfg.krakenInterval}),
    request(provider.base+"/0/public/Ticker",{pair:meta.product})
  ]);
  if(ohlc.data?.error?.length)throw new Error("Kraken: "+ohlc.data.error.join(", "));
  const result=ohlc.data?.result||{},key=Object.keys(result).find(k=>k!=="last");
  const rows=key?result[key]:null;
  if(!Array.isArray(rows)||rows.length<50)throw new Error("Kraken sem candles suficientes");
  const intervalMs=cfg.krakenInterval*60000,now=Date.now();
  const candles=clean(rows.slice(-Math.min(300,Math.max(60,limit))).map(b=>{
    const ts=Number(b[0])*1000;
    const isOpen=now<ts+intervalMs+1500;
    return {timestamp:new Date(ts).toISOString(),open:Number(b[1]),high:Number(b[2]),low:Number(b[3]),close:Number(b[4]),volume:Number(b[6]||0),complete:!isOpen,isOpen};
  }));
  const last=candles[candles.length-1],delaySec=Math.max(0,Math.round((now-(Date.parse(last.timestamp)+intervalMs))/1000));
  const tickResult=ticker.data?.result||{},tickKey=Object.keys(tickResult)[0],tick= tickKey ? Number(tickResult[tickKey]?.c?.[0]) : NaN;
  const price=finite(tick)?tick:Number(last.close);
  if(!finite(price))throw new Error("Kraken sem cotação");
  if(!last.isOpen&&delaySec>cfg.maxDelay)throw new Error("Kraken candle atrasado ("+delaySec+"s)");
  return {
    success:true,source:"Kraken "+meta.product,symbol:asset,displaySymbol:meta.display,timeframe,
    candles,last,price,delayedBy:delaySec,candleTimestamp:last.timestamp,
    quoteTimestamp:new Date().toISOString(),candleAgeSec:Math.max(0,Math.round((now-Date.parse(last.timestamp))/1000)),
    candleDelaySec:delaySec,quoteAgeSec:0,stale:false,marketState:"open",
    realOpenBar:last.isOpen===true,liveM1:timeframe==="1m",provider:"Kraken",
    feedNotice:meta.product+" OHLC + cotação via Kraken; TradingView mostra "+meta.display,
    fetchedInMs:Date.now()-started
  };
}

async function coinbase(provider,asset,timeframe,limit){
  const meta=provider.assets[asset],cfg=TF[timeframe],started=Date.now();
  const [cr,tr]=await Promise.all([
    request(provider.base+"/products/"+meta.product+"/candles",{granularity:cfg.coinbaseGranularity}),
    request(provider.base+"/products/"+meta.product+"/ticker")
  ]);
  if(!Array.isArray(cr.data)||!cr.data.length)throw new Error("Coinbase sem candles");
  const intervalMs=cfg.coinbaseGranularity*1000,now=Date.now();
  const candles=clean(cr.data.slice(0,Math.min(300,Math.max(60,limit))).map(b=>{
    const ts=Number(b[0])*1000,isOpen=now<ts+intervalMs+1500;
    return {timestamp:new Date(ts).toISOString(),open:Number(b[3]),high:Number(b[2]),low:Number(b[1]),close:Number(b[4]),volume:Number(b[5]||0),complete:!isOpen,isOpen};
  }));
  if(candles.length<50)throw new Error("Coinbase poucos candles");
  const last=candles[candles.length-1],price=Number(tr.data?.price);
  if(!finite(price))throw new Error("Coinbase sem cotação");
  const delaySec=Math.max(0,Math.round((now-(Date.parse(last.timestamp)+intervalMs))/1000));
  if(!last.isOpen&&delaySec>cfg.maxDelay)throw new Error("Coinbase candle atrasado ("+delaySec+"s)");
  return {
    success:true,source:"Coinbase "+meta.product,symbol:asset,displaySymbol:meta.display,timeframe,
    candles,last,price,delayedBy:Math.max(0,delaySec),candleTimestamp:last.timestamp,
    quoteTimestamp:new Date().toISOString(),candleAgeSec:Math.max(0,Math.round((now-Date.parse(last.timestamp))/1000)),
    candleDelaySec:delaySec,quoteAgeSec:0,stale:false,marketState:"open",
    realOpenBar:last.isOpen===true,liveM1:timeframe==="1m",
    provider:"Coinbase",feedNotice:meta.product+" OHLC + cotação via Coinbase; TradingView mostra "+meta.display,
    fetchedInMs:Date.now()-started
  };
}

async function getMarket(asset,timeframe,requestedLimit=300){
  if(!["BTCUSD","ETHUSD"].includes(asset))throw new Error("Ativo inválido");
  if(!TF[timeframe])throw new Error("Timeframe inválido");
  const limit=Math.min(600,Math.max(60,Number(requestedLimit)||300)),key=asset+":"+timeframe+":"+limit;
  const hit=cache.get(key);if(hit&&Date.now()-hit.t<CACHE_MS)return hit.v;
  if(inflight.has(key))return inflight.get(key);

  const p=(async()=>{
    const errors=[];
    for(const provider of PROVIDERS){
      try{
        const v=provider.name==="Coinbase"
          ?await coinbase(provider,asset,timeframe,limit)
          :await kraken(provider,asset,timeframe,limit);
        if(v?.success)return v;
      }catch(e){errors.push(provider.name+": "+e.message);}
    }
    const old=cache.get(key);
    if(old&&Date.now()-old.t<120000)return {...old.v,stale:true,liveM1:false,feedNotice:old.v.feedNotice+" • snapshot anterior após falha temporária"};
    throw new Error("Todos os feeds falharam — "+errors.join(" | "));
  })().then(v=>{cache.set(key,{t:Date.now(),v});inflight.delete(key);return v}).catch(e=>{inflight.delete(key);throw e});
  inflight.set(key,p);return p;
}

async function handler(req,res){
  res.setHeader("Cache-Control","no-store,max-age=0");
  try{
    const asset=String(req.query.asset||"BTCUSD").toUpperCase();
    const timeframe=String(req.query.timeframe||"1m");
    const limit=Math.min(600,Math.max(60,Number(req.query.limit)||300));
    res.status(200).json(await getMarket(asset,timeframe,limit));
  }catch(e){
    console.error("CRYPTO MARKET ERROR",e.message);
    res.status(502).json({success:false,error:"Falha no feed de mercado cripto",details:e.message,source:"Kraken/Coinbase BTC/ETH"});
  }
}
handler.getMarket=getMarket;
module.exports=handler;
