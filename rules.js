/* Calendar-day rules. Completed history is immutable; overdue tasks never roll forward by the clock. */
(function(root){
 const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
 const parse=s=>new Date(s+'T12:00:00');
 const days=(s,n)=>{const d=parse(s);d.setDate(d.getDate()+n);return iso(d)};
 const month=s=>{const d=parse(s),day=d.getDate();d.setDate(1);d.setMonth(d.getMonth()+1);const last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();d.setDate(Math.min(day,last));return iso(d)};
 const base=(created,delivery,completed=[])=>{
  const last=completed.at(-1)?.date;
  if(!last)return delivery?[days(created,14),days(delivery,-14)].sort()[0]:days(created,14);
  if(!delivery)return month(last);
  if(last>=delivery)return days(last,7);
  const pre=days(delivery,-14);
  if(last>=pre)return delivery;
  return [month(last),pre].sort()[0];
 };
 const due=l=>l.closed?'':l.followOverride||base(l.created,l.deliveryDate,l.followHistory);
 const normalize=s=>s.trim().toUpperCase().replace(/\s+/g,'');
 const api={iso,days,month,base,due,normalize};root.DPARules=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
