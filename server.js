const express=require("express");const cors=require("cors");const path=require("path");const marketModule=require("./api/market");
const app=express(),PORT=process.env.PORT||3000,PUBLIC_DIR=path.join(__dirname,"public");
app.use(cors());app.use(express.json({limit:"1mb"}));app.use(express.static(PUBLIC_DIR,{index:"index.html"}));
app.get("/",(_req,res)=>res.sendFile(path.join(PUBLIC_DIR,"index.html")));
const market=marketModule.getMarket;
app.get("/api/health",async(_req,res)=>{try{const m=await market("BTCUSD","1m");res.json({status:"OK",marketConnected:true,source:m.source,symbol:m.symbol,history:"crypto",aiEnabled:false,mode:"ALERTAS",timestamp:new Date().toISOString()})}catch(e){res.status(503).json({status:"DEGRADED",marketConnected:false,history:"crypto",aiEnabled:false,mode:"ALERTAS",error:e.message})}});
app.get("/api/market",async(req,res)=>{try{const asset=String(req.query.asset||"BTCUSD").toUpperCase();const timeframe=String(req.query.timeframe||"1m");const m=await market(asset,timeframe,300);res.json({...m,price:m.price??m.last?.close,quoteTimestamp:m.quoteTimestamp??m.last?.timestamp})}catch(e){res.status(502).json({success:false,error:"Falha no feed de mercado cripto",details:e.message})}});
app.listen(PORT,()=>console.log("RB Crypto Sniper PRO running on port "+PORT));