const round = value => Math.round(value * 100) / 100;
export function inferredCostBasis(asset) {
  if (!['stock','fund'].includes(asset.type)) return null;
  if ('costBasis' in asset) return asset.costBasis;
  const r=asset.reported;
  // A reported P/L applies only to exactly the reported position value.
  // Extra units or a different valuation must not inherit that old cost.
  if (!r || r.date!==asset.asOf || !Number.isFinite(r.value) || !Number.isFinite(asset.value) || !Number.isFinite(r.unrealized) || Math.abs(r.value-asset.value)>.011) return null;
  const amount=round(r.value-r.unrealized);
  return amount>=0?{amount,quantity:asset.quantity??null,currency:asset.currency,method:'reported'}:null;
}
export function applyInvestmentInfo(input) {
  const state=structuredClone(input);
  for (const a of state.assets) {
    if (!['stock','fund'].includes(a.type)) continue;
    const basis=a.costBasis;
    if (!basis || basis.currency!==a.currency || basis.quantity!==a.quantity) {
      a.investment={cost:null,averageCost:null,profit:null,returnPercent:null,status:basis?'quantity_changed':'unknown'};
      continue;
    }
    const profit=Number.isFinite(a.value)?round(a.value-basis.amount):null;
    a.investment={cost:basis.amount,averageCost:a.quantity>0?basis.amount/a.quantity:null,profit,returnPercent:basis.amount>0&&profit!=null?profit/basis.amount*100:null,status:'known',currency:a.currency};
  }
  return state;
}
