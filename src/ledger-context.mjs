// The model interprets language; the ledger verifies provenance and accounting.
// Quotes are complete user turns, never assistant suggestions or page content.
const canonical=text=>String(text||'').normalize('NFKC').replace(/\s+/g,' ').trim();
const writes=new Set(['record_holding_change','record_cash_flow','set_holding_balance','remove_instrument']);
export const explanationOnly=text=>/^(?:啥意思|什么意思|没看懂|不明白|解释一下)[？?。！!]*$/u.test(canonical(text));
function invalid(message) {
  return Object.assign(new Error(message),{ledgerClarification:{status:'needs_information',requiresUserInput:false,reason:'invalid_context',missing:[message],question:'这笔还没有入账，正在核对之前确认的信息。',instruction:'这是工具上下文参数问题，不是用户缺少资料。请按当前对话纠正 interpretation，不能把内部核验问题原样问用户；如果用户在问原因，直接解释，不调用写入工具。'}});
}
export function interpretedEvidence(meta,args,tool) {
  const input=args.interpretation;
  if(!input)return null;
  if(input.intent!=='execute'||explanationOnly(meta.question))throw invalid('本轮是解释或查询请求，不应执行记账');
  const turns=input.userTurns;
  if(!Array.isArray(turns)||!turns.length||turns.length>13||turns.some(t=>typeof t!=='string'||!t.trim())||canonical(turns.at(-1))!==canonical(meta.question))throw invalid('引用必须包含本轮完整用户原话');
  if(turns.length>1&&meta.contextEnabled===false)throw invalid('本轮未启用历史上下文');
  const selected=[{content:meta.question,created_at:meta.startedAt}];
  let cursor=(meta.history||[]).length;
  for(let i=turns.length-2;i>=0;i--){
    const answer=meta.history?.[--cursor],user=meta.history?.[--cursor];
    if(answer?.role!=='assistant'||user?.role!=='user'||canonical(user.content)!==canonical(turns[i]))throw invalid('只能引用连续的同一笔未完成操作，不能跳过用户消息或编造原话');
    const calls=answer.metadata?.toolCalls||[];
    const sameTarget=c=>c.name===tool&&(args.query?canonical(c.args?.query)===canonical(args.query):c.args?.cashAssetId===args.cashAssetId);
    const saved=c=>writes.has(c.name)&&['applied','pending'].includes(c.output?.status);
    // A partially completed batch may continue its explicitly unfinished target,
    // but never reuse the completed target's authorization.
    if(calls.some(saved)&&(!calls.some(c=>sameTarget(c)&&c.output?.status==='needs_information')||calls.some(c=>sameTarget(c)&&saved(c))))throw invalid('不能把已经入账或待入账的指令作为新操作重复执行');
    selected.unshift(user);
  }
  const text=selected.map(t=>t.content).join('\n');
  for(const field of ['cashSourceQuote','cashDeltaQuote'])if(input[field]!=null&&(!canonical(input[field])||!selected.some(t=>canonical(t.content).includes(canonical(input[field])))))throw invalid(field+' 必须引用用户原话，不能来自助手或页面');
  const dated=selected.findLast(t=>/今天|昨天|昨日|前天|\d{4}-\d{2}-\d{2}/.test(t.content))||selected[0];
  const at=typeof dated.created_at==='number'?dated.created_at:Date.parse(dated.created_at);
  return {text,dateText:dated.content,at:Number.isFinite(at)?at:meta.startedAt||Date.now(),interpreted:true,interpretation:input};
}
