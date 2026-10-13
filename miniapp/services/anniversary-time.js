function elapsed(item, stamp = Date.now()) {
  const start=Date.parse(item.elapsedFrom||'')
  if(!Number.isFinite(start))return {label:'时间未记录',text:'—'}
  const difference=stamp-start, value=Math.max(0,Math.floor(Math.abs(difference)))
  const pad=(n,size=2)=>String(n).padStart(size,'0')
  const days=Math.floor(value/86400000),hours=Math.floor(value/3600000)%24
  const minutes=Math.floor(value/60000)%60,seconds=Math.floor(value/1000)%60,milliseconds=value%1000
  const label=difference<0?'距离开始还有':item.elapsedBasis==='latest'?'距最近一次已过去':'距今已过去'
  return {label,text:days+'天 '+pad(hours)+':'+pad(minutes)+':'+pad(seconds)+'.'+pad(milliseconds,3)}
}
function remaining(item, stamp = Date.now()) {
  const target=Date.parse((item.nextDate||'')+'T00:00:00+08:00')
  if(!Number.isFinite(target))return {label:'距离下一次还有',text:'—'}
  if(stamp>=target&&stamp<target+86400000)return {label:'下一次纪念日',text:'就是今天'}
  if(stamp>=target)return {label:'距离下一次还有',text:'正在更新…'}
  return {...elapsed({elapsedFrom:new Date(target).toISOString()},stamp),label:'距离下一次还有'}
}
module.exports={elapsed,remaining}
