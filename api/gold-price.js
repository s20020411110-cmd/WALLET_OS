const OZ=31.1034768;
const json=(res,status,body)=>{res.status(status).setHeader('Content-Type','application/json; charset=utf-8').setHeader('Cache-Control','s-maxage=20, stale-while-revalidate=40').json(body)};
async function timed(url){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6500);try{const r=await fetch(url,{signal:controller.signal,headers:{accept:'application/json','user-agent':'WALLET-OS/1.0'}});if(!r.ok)throw new Error('HTTP '+r.status);return await r.json()}finally{clearTimeout(timer)}}
export default async function handler(req,res){
 if(req.method!=='GET'){res.setHeader('Allow','GET');return json(res,405,{error:'Method not allowed'})}
 const failures=[];
 try{
  const x=await timed('https://xaus.com/api/v1/spot?currency=USD&unit=gram&compact=1');
  const oz=Number(x?.spot_usd_oz),gram=Number(x?.per_gram_usd||x?.xau?.price),stamp=x?.price_as_of||x?.data_state?.as_of||x?.updated_at;
  const age=stamp?Date.now()-Date.parse(stamp):Infinity;
  if(oz>0&&gram>0&&Number.isFinite(age)&&age>=-30000&&age<=180000&&x?.data_state?.status!=='unavailable')
   return json(res,200,{ok:true,source:'xaus',price_usd_oz:oz,price_usd_gram:gram,price_as_of:new Date(stamp).toISOString(),fetched_at:new Date().toISOString(),fresh:true});
  failures.push('XAUS quote missing, stale, or invalid');
 }catch(e){failures.push('XAUS: '+String(e.message||e))}
 try{
  const x=await timed('https://api.gold-api.com/price/XAU'),oz=Number(x?.price),stamp=x?.updatedAt||x?.updated_at,age=stamp?Date.now()-Date.parse(stamp):Infinity;
  if(oz>0&&Number.isFinite(age)&&age>=-30000&&age<=180000)
   return json(res,200,{ok:true,source:'gold-api',price_usd_oz:oz,price_usd_gram:oz/OZ,price_as_of:new Date(stamp).toISOString(),fetched_at:new Date().toISOString(),fresh:true,fallback:true});
  failures.push('Gold API quote missing, stale, or invalid');
 }catch(e){failures.push('Gold API: '+String(e.message||e))}
 return json(res,503,{ok:false,error:'No fresh gold quote is currently available',failures,fetched_at:new Date().toISOString()});
}
