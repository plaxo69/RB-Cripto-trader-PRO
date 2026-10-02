(function(root){
  function validLevels(type,entry,tp,sl){
    if(!Number.isFinite(entry)||!Number.isFinite(tp)||!Number.isFinite(sl)) return false;
    return type==='BUY' ? sl<entry&&entry<tp : type==='SELL' ? tp<entry&&entry<sl : false;
  }
  const sniper=root.RBGoldSniper;
  if(!sniper||typeof sniper.analyze!=='function') return;
  const original=sniper.analyze;
  sniper.analyze=function(main,m5,m15,h1){
    const r=original(main,m5,m15,h1);
    if(!r||!['BUY','SELL'].includes(r.type)) return r;
    if(validLevels(r.type,Number(r.price),Number(r.tp),Number(r.sl))) return r;
    const blocked=Object.assign({},r,{type:'WAIT',confidence:0});
    blocked.rejectionReasons=(r.rejectionReasons||[]).slice();
    blocked.rejectionReasons.push('trade bloqueada: TP/SL inválidos ou iguais');
    blocked.filters=Object.assign({},r.filters||{},{invalidTargetsBlocked:true});
    return blocked;
  };
})(globalThis);
