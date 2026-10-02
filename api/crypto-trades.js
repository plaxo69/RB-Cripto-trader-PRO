const REPO='plaxo69/RB-Cripto-trader-PRO',BRANCH='main',PATH='historico-crypto-trades.json',API='https://api.github.com';
function send(res,status,body){return res.status(status).json(body)}
module.exports=async function handler(req,res){
 if(req.method!=='GET')return send(res,405,{ok:false,error:'Method not allowed'});
 const token=process.env.GITHUB_TOKEN;if(!token)return send(res,500,{ok:false,error:'GITHUB_TOKEN não está configurado no Vercel.'});
 try{const r=await fetch(`${API}/repos/${REPO}/contents/${PATH}?ref=${BRANCH}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'RB-CRYPTO-SNIPER'}});
 if(r.status===404)return send(res,200,{ok:true,trades:[],total:0,source:'github',branch:BRANCH});
 const data=await r.json();if(!r.ok)return send(res,r.status,{ok:false,error:data?.message||'Falha ao ler histórico Crypto.'});
 const raw=Buffer.from(data.content||'','base64').toString('utf8'),parsed=JSON.parse(raw),trades=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.trades)?parsed.trades:[]);
 const limit=Math.min(Math.max(parseInt(req.query?.limit||'1000',10)||1000,1),5000);
 return send(res,200,{ok:true,trades:trades.filter(t=>t&&['BTCUSD','ETHUSD'].includes(String(t.asset||''))).slice(-limit),total:trades.length,source:'github',branch:BRANCH,exportedAt:parsed?.exportedAt||null});
 }catch(error){return send(res,500,{ok:false,error:error.message||'Erro interno.'})}
};