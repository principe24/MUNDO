"use strict";

// Local file format exported by the host panel. Discard any extension fields
// when reading. Only a bounded, typed record reaches the inspector or the DOM.
window.MundoAheadReport=(()=>{
  const maxFileBytes=512*1024,capacity=256;
  const states=new Set(["unreported","active","changed","released","turned","crossed"]);
  const closed=state=>state==="changed" || state==="released" || state==="turned" || state==="crossed";
  const natural=n=>Number.isSafeInteger(n) && n>=0;
  const cell=n=>Number.isInteger(n) && n>=-2147483648 && n<=2147483647;
  function expect(value,message){
    if(!value)throw new Error(message);
  }
  function parse(text){
    expect(typeof text==="string" && text.length<=maxFileBytes,"El informe supera el límite de tamaño.");
    let report;
    try{report=JSON.parse(text);}catch{throw new Error("El archivo no contiene JSON válido.");}
    expect(report?.format==="MUNDO-ahead-usage" && (report.version===1 || report.version===2),"Se necesita un informe de precarga del anfitrión, versión 1 o 2.");
    expect(report.limit===capacity && natural(report.totalOffers) && natural(report.omittedOffers) &&
      Array.isArray(report.entries) && report.entries.length<=capacity &&
      report.totalOffers-report.omittedOffers===report.entries.length,"El resumen de ofertas está incompleto o es incompatible.");
    let last=0,totalServed=0,totalInterrupted=0;
    const entries=report.entries.map((item,i)=>{
      const check=value=>expect(value,"Datos incompatibles en la oferta "+(i+1)+".");
      check(item && typeof item==="object" && !Array.isArray(item));
      const {ordinal,seat,revision,epoch,profile,fromX,fromZ,cx,cz,carRoot,plannedBytes,requiredBytes,
        servedBytes,verifiedBytes,usedBytes,discardedBytes,state}=item;
      const cap=typeof profile==="string" && MundoZones.aheadLimits(profile);
      check(cap && natural(ordinal) && ordinal>last && ordinal<=report.totalOffers && (seat===1 || seat===2) &&
        natural(epoch) && typeof revision==="string" && /^[0-9a-f]{64}$/.test(revision) && revision.length===64);
      check([fromX,fromZ,cx,cz].every(cell) && Math.max(Math.abs(cx-fromX),Math.abs(cz-fromZ))===1);
      check(carRoot===null || (typeof carRoot==="string" && /^[1-9][0-9]{0,19}$/.test(carRoot) &&
            String(BigInt(carRoot))===carRoot && BigInt(carRoot)<=18446744073709551615n));
      check(natural(plannedBytes) && plannedBytes>=24 && plannedBytes<=cap.bytes &&
        natural(requiredBytes) && requiredBytes>=plannedBytes && requiredBytes<=(profile==="mobile"?4:8)*1024*1024);
      check(natural(servedBytes) && states.has(state));
      const uniqueServedBytes=item.uniqueServedBytes,interruptedPages=item.interruptedPages;
      check(natural(uniqueServedBytes) && uniqueServedBytes<=Math.min(servedBytes,plannedBytes) && natural(interruptedPages));
      const staged=report.version===2;
      const via=staged?item.via:null,middleBytes=staged?item.middleBytes:null,finalBytes=staged?item.finalBytes:null;
      if(staged)check(via===null || ((via==="x" || via==="z") && fromX!==cx && fromZ!==cz));
      if(state==="unreported"){
        if(staged)check(via===null && middleBytes===null && finalBytes===null);
        check(verifiedBytes===null && usedBytes===null);
      }else{
        check(natural(verifiedBytes) && verifiedBytes<=plannedBytes && natural(usedBytes) && usedBytes<=verifiedBytes);
        if(staged){
          check(natural(middleBytes) && natural(finalBytes) && middleBytes+finalBytes===usedBytes &&
            (via!==null || middleBytes===0) && (state==="crossed" || finalBytes===0));
        }else check(usedBytes===0 || state==="crossed");
      }
      check(closed(state)?discardedBytes===verifiedBytes-usedBytes:discardedBytes===null);
      last=ordinal;totalServed+=servedBytes;totalInterrupted+=interruptedPages;
      check(Number.isSafeInteger(totalServed) && Number.isSafeInteger(totalInterrupted));
      return {ordinal,seat,revision,epoch,profile,fromX,fromZ,cx,cz,carRoot,plannedBytes,requiredBytes,
        servedBytes,uniqueServedBytes,interruptedPages,verifiedBytes,usedBytes,discardedBytes,state,via,middleBytes,finalBytes};
    });
    return {version:report.version,entries,totalOffers:report.totalOffers,omittedOffers:report.omittedOffers};
  }
  return {parse,closed,maxFileBytes};
})();
