import { marketOverview } from './markets.mjs';
import { readMarketBriefs, publicBriefData, saveMarketBriefs } from './market-briefs.mjs';
import { searchSecurities, refreshStocks } from './market.mjs';
import { security, isoDay, marketDay } from './securities.mjs';
import { stockDetails } from './instrument-details.mjs';
import { fundReference, fundReferenceSummary } from './fund-reference.mjs';

export function createAssistantServices(store,{refreshOverview=async()=>{},includeHoldings=false,includePageData=false,stockOptions={},detailsOptions={}}={}) {
  return {
    ...(includePageData?{async getInstrumentDetails({assetId,key}) {
      const asset=assetId?store.state().assets.find(a=>a.id===assetId):null;
      if(assetId&&!asset)throw new Error('未找到该资产');
      const instrument=asset?.security?.key||(asset?.fund?.code?'FUND.'+asset.fund.code:key);
      if(!instrument)throw new Error('请提供资产编号或完整股票代码');
      const details=asset?.type==='fund'?{status:'not_applicable',message:'基金不套用个股 PE 或股息指标'}:await stockDetails(store,instrument,detailsOptions);
      return {assetId:asset?.id||null,key:instrument,details,priceHistory:store.priceHistory(instrument),...(asset?{valuation:asset.valuation,investment:asset.investment}:{}),...(asset?.type==='fund'?{marketReference:fundReferenceSummary(fundReference(store,asset.id))}:{})};
    }}:{}),
    async getMarketData({market,date}) {
      if(!['US','HK'].includes(market))throw new Error('请选择美国或港股市场');
      if(date&&isoDay(date)>marketDay(market,new Date()))throw new Error('不能查询未来市场数据');
      await refreshOverview();saveMarketBriefs(store);
      const saved=readMarketBriefs(store,{market,date}).latest.find(r=>r.market===market);
      if(saved)return {status:'available',...publicBriefData(saved,includeHoldings)};
      const view=marketOverview(store,market),dates=[...new Set(view.benchmarks.flatMap(d=>d.history.map(q=>q.date)))].filter(d=>!date||d<=date).sort();
      const effective=dates.at(-1);if(!effective)return {status:'unavailable',market,requestedDate:date||null,availableDates:dates,instruction:'没有已保存的完整交易日数据，不能编造指数或涨跌。'};
      const indices=view.benchmarks.map(d=>({name:d.name,quote:d.history.find(q=>q.date===effective)})).filter(d=>d.quote).map(d=>({name:d.name,price:d.quote.price,percent:d.quote.percent}));
      return {status:date&&date!==effective?'nearest_available':'available',market,requestedDate:date||null,date:effective,indices,
        instruction:date&&date!==effective?`没有${date}完整行情，返回最近已保存的${effective}，不得写成${date}交易。`:'仅为已保存的收盘数据；无资料的板块与持仓不推断。'};
    },
    async getStockQuote({market,symbol,query}) {
      if(!['US','HK','SH','SZ'].includes(market))throw new Error('请选择有效股票市场');
      let target;
      if(symbol)target=security({market,symbol});
      else if(query){const found=await searchSecurities(store,query,market);if(found.items.length!==1)return {status:'choose_security',matches:found.items,instruction:'请依据用户指定代码选择准确市场和币种；不能将多个候选混为同一证券。'};target=found.items[0];}
      else return {status:'needs_information',missing:['股票代码或名称']};
      await refreshStocks(store,{...stockOptions,keys:[target.key]});
      const quote=store.getKV('stock_quote:'+target.key),attempt=store.getKV('stock_attempt:'+target.key);
      if(!quote)return {status:'unavailable',key:target.key,message:'行情暂不可用，未填入估算价格'};
      return {status:attempt?.error?'cached':'available',quote,...(attempt?.error?{message:'最新请求失败，以下是之前保存的报价；请按实际日期引用'}:{})};
    }
  };
}
