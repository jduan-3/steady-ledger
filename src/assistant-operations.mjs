// Business operations outlive a model run. The ledger's existing transactional
// receipts remain the authority; this journal stores drafts and their provenance.
const methods={recordHoldingChange:'record_holding_change',recordCashFlow:'record_cash_flow',setHoldingBalance:'set_holding_balance',removeInstrument:'remove_instrument'};
const key=id=>'assistant_operations:'+id;
const normalize=text=>String(text||'').normalize('NFKC').replace(/\s+/g,' ').trim();
const retry=text=>/^(?:请)?(?:重试|再试一次|继续|继续记录|继续入账)[。！!]?$/u.test(normalize(text));
const freshAction=/买了|买入|卖了|卖出|加仓|减仓|申购|赎回|收到|到账|花了|支付|多了|删除|移除|校准/;
const dateReply=text=>/^(?:是|就|我是)?(?:今天|昨天|昨日|前天|\d{4}-\d{2}-\d{2})(?:买的|买入的|卖的|卖出的|下单的|成交的|申购的|赎回的|的)?[。！!]?$/u.test(normalize(text));

export function operationContext(store,meta) {
  let prior=store.getKV(key(meta.conversationId));
  if(prior)prior=store.getKV(key(meta.conversationId)+':'+prior.id)||prior;
  // Keep older failed operations recoverable even after another operation was
  // started in this conversation. Completed records are never text-deduplicated.
  for(const message of [...(meta.history||[])].reverse())if(message.role==='user'&&message.metadata?.operationId&&normalize(message.content)===normalize(meta.question)){
    const candidate=store.getKV(key(meta.conversationId)+':'+message.metadata.operationId);
    if(candidate?.status==='failed'){prior=candidate;break;}
  }
  const sameScope=prior&&prior.scopeId===meta.scopeId&&prior.generation===meta.ledgerGeneration&&prior.contextEnabled===meta.contextEnabled;
  const sameQuestion=sameScope&&normalize(meta.question)===normalize(prior.question);
  const adjacent=meta.history?.at(-1)?.metadata?.operationId===prior?.id;
  const followUp=sameScope&&meta.contextEnabled&&adjacent&&prior.operations.some(o=>o.status==='needs_information')&&meta.question.length<=100&&(!freshAction.test(meta.question)||dateReply(meta.question));
  const recover=sameScope&&prior.status==='failed'&&(sameQuestion||retry(meta.question));
  if(recover||followUp||sameQuestion&&prior.status==='needs_information')return {...prior,recovering:true,retry:recover,reply:meta.question,replies:followUp?[...(prior.replies||[]),meta.question]:prior.replies||[]};
  return {id:meta.requestId,scopeId:meta.scopeId,generation:meta.ledgerGeneration,contextEnabled:meta.contextEnabled,question:meta.question,startedAt:meta.startedAt,operations:[],status:'open'};
}

export function operationServices(store,meta,makeServices,control) {
  const saved=meta.operationContext&&store.getKV(key(meta.conversationId)+':'+meta.operationContext.id);
  const intent=structuredClone(saved?.id===meta.operationContext?.id&&saved?.generation===meta.ledgerGeneration?{...saved,retry:meta.operationContext.retry,replies:meta.operationContext.replies}:meta.operationContext);
  if(!intent)return {services:makeServices(meta,control),finish:()=>null};
  // Keep the original ledger request identity on a retry or clarification.
  // Replayed writes still pass authorization and signature checks in the ledger.
  const boundMeta={...meta,requestId:intent.id,...(intent.retry?(intent.lastInput||{question:intent.question,startedAt:intent.startedAt}):{})};
  const services=makeServices(boundMeta,control);
  const persist=()=>{store.setKV(key(meta.conversationId)+':'+intent.id,intent);store.setKV(key(meta.conversationId),intent);};
  for(const [method,tool] of Object.entries(methods))if(services[method]){
    const execute=services[method];
    services[method]=async args=>{
      const assets=store.state().assets;
      const matches=assets.filter(a=>args.query?[a.name,a.security?.key,a.fund?.code].filter(Boolean).some(s=>normalize(s).includes(normalize(args.query))):a.type==='cash'&&a.currency===(args.currency||'CNY')&&(!args.cashAssetId||a.id===args.cashAssetId));
      const target=matches.length===1?matches[0].id:normalize(args.query||args.cashAssetId||'cash');
      const operationKey=tool+':'+(args.target||'')+':'+target;
      let operation=intent.operations.find(o=>o.key===operationKey);
      if(!operation){operation={key:operationKey,tool};intent.operations.push(operation);}
      intent.lastInput={question:boundMeta.question,startedAt:boundMeta.startedAt,history:boundMeta.history};
      Object.assign(operation,{args:structuredClone(args),status:'executing',userQuestion:meta.question});persist();
      try{
        const result=await execute(args);
        Object.assign(operation,{status:result.status||'complete',result});persist();return result;
      }catch(error){
        Object.assign(operation,{status:error.ledgerClarification?.status||'failed',result:error.ledgerClarification||{message:error.message}});persist();throw error;
      }
    };
  }
  const finish=status=>{
    if(!intent.operations.length)return null;
    // A crash may occur after the ledger commit but before a tool result or
    // journal update. Receipts recover that window without repeating the write.
    const receipts=store.ledgerEntries({limit:-1}).filter(e=>e.requestId===intent.id&&e.generation===intent.generation);
    intent.receipts=receipts;
    intent.status=status==='failed'||intent.operations.some(o=>['failed','executing'].includes(o.status))?'failed':intent.operations.some(o=>o.status==='needs_information')?'needs_information':'done';
    intent.lastRequestId=meta.requestId;persist();
    return intent;
  };
  return {services,finish};
}

export function operationSummary(intent) {
  const receipts=intent?.receipts||[];
  return receipts.filter(e=>['applied','pending'].includes(e.status)).map(e=>{
    const name=e.asset?.name||'记录';
    if(e.status==='pending')return name+'已保存待入账';
    if(e.kind==='cash')return name+'已记录'+(e.side==='income'?'收入':'支出')+e.amount+' '+e.asset.currency;
    if(e.kind==='holding')return name+'已记录'+(e.side==='buy'?'买入':'卖出')+e.quantity+(e.asset.unit||'份');
    return name+'已完成更新';
  }).join('；');
}
