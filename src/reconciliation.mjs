import { nowDate } from './domain.mjs';
import { isoDay } from './securities.mjs';

export function reconcile(store,input) {
  const state=store.state({raw:true}),today=nowDate(state.preferences.timeZone),date=isoDay(input.date);
  if(state.revision!==input.revision||date>today)throw new Error('账本版本或对账日期无效，请刷新');
  const asset=state.assets.find(a=>a.id===input.assetId&&['cash','stock','fund'].includes(a.type));
  if(!asset||!Number.isFinite(input.actual)||input.actual<0||input.actual>1e14)throw new Error('请选择账户并填写有效的实际余额或数量');
  const cash=asset.type==='cash',unit=cash?'金额':asset.type==='stock'?'股':'份';
  const point=date===today?asset:store.snapshotOn(date)?.positions?.find(p=>p.id===asset.id&&p.type===asset.type&&p.currency===asset.currency);
  const book=cash?point?.value:point?.quantity;
  if(!Number.isFinite(book))throw new Error('该日期缺少已保存的账户余额或数量，无法对账');
  const pending=store.ledgerPage({status:'pending',assetId:asset.id,limit:100});
  const difference=Number((input.actual-book).toFixed(cash?2:8));
  const result={book,actual:input.actual,difference,unit,currency:asset.currency,pending:pending.items.map(e=>e.label),pendingCount:pending.total};
  if(!input.save)return result;
  const reason=String(input.reason||'').trim();
  if(!reason||reason.length>300)throw new Error('请填写对账说明（最多 300 字）');
  const adjusted=input.adjust===true&&difference!==0;
  if(adjusted&&(date!==today||pending.total||!cash))throw new Error('仅支持调整今天且无待入账的现金余额；证券数量请核对成本后校准持仓');
  const entry={id:'reconcile:'+state.revision+':'+asset.id,signature:JSON.stringify([date,input.actual,reason,adjusted]),asset:{id:asset.id,name:asset.name,currency:asset.currency},generation:store.ledgerGeneration(),kind:'reconcile',date,label:'账户对账 · '+asset.name,createdAt:new Date().toISOString(),...result,adjusted,reason};
  return store.postLedgerEntry(entry,current=>{
    if(current.revision!==input.revision||store.ledgerPage({status:'pending',assetId:asset.id,limit:1}).total!==pending.total)throw new Error('账本或待入账记录已更新，请重新核对');
    if(adjusted){const target=current.assets.find(a=>a.id===asset.id);target.value=input.actual;target.asOf=date;}
    return {state:current,receipt:{message:reason}};
  });
}
