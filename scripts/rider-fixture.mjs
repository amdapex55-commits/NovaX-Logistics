// Isolated UI fixture. This file is never referenced by the production portal.
export function installFixture(window, options = {}) {
  const now = new Date().toISOString(), user = 'fixture-user', rider = 'fixture-rider';
  const stages = ['New booked','Collected by rider','Parcel now in transit','Parcel received at destination','Parcel out for delivery','Ready for return','Return in transit','Return received at origin','Return out for delivery','Delivered','Refused','Consignee not available','Return to shipper'];
  const fixture = { online: options.online !== false, failLoad: options.failLoad || false, failRpc: null, requests: [], saved: new Map(), rows: [], user, rider, cash: {gross:1200,expenses:200,net:1000,count:1,pending:0,review:false,expense_rows:[]} };
  fixture.rows = stages.map((status,i)=>({id:'p'+i,awb:'N'+String(1000000+i),client_id:'client-1',rider_id:rider,status,cod_amount:1200,consignee:'Recipient '+i,phone:'03001234567',address:'Destination address, building 12',city:'Lahore',updated_at:now,status_since:now,delivered_at:status==='Delivered'?now:null,meta:{}}));
  fixture.rows[0].meta={pickupCity:'Lahore'};           // New booked in Lahore -> pickup
  fixture.rows[1].meta={pickupCity:'Lahore'};fixture.rows[1].city='Karachi'; // collected, going to Karachi -> transit
  fixture.rows[5].meta={pickupCity:'Karachi'};          // ready for return to Karachi -> transit
  fixture.rows[6].meta={pickupCity:'Lahore'};fixture.rows[6].city='Karachi'; // return coming home -> incoming
  fixture.rows[7].meta={pickupCity:'Lahore'};fixture.rows[7].city='Karachi';
  fixture.rows[8].meta={pickupCity:'Lahore'};fixture.rows[8].city='Karachi';
  if(options.large)for(let i=0;i<1005;i++)fixture.rows.push({...fixture.rows[2],id:'large'+String(i).padStart(5,'0'),awb:'B'+i});
  if(options.long)fixture.rows[0].awb='A'.repeat(80);
  if(options.conflict)fixture.rows[4].meta.paymentMode='non-cod';
  if(options.swap){fixture.rows[4].cod_amount=0;fixture.rows[4].meta={...fixture.rows[4].meta,swapLeg:'out',swapId:'SW-0001',swapPairAwb:'N9999999',paymentMode:'Non COD Prepaid'};}
  Object.defineProperty(window.navigator,'onLine',{configurable:true,get:()=>fixture.online});
  Object.defineProperty(window.navigator,'locks',{configurable:true,value:{request:async(_key,fn)=>fn()}});
  Object.defineProperty(window.navigator,'geolocation',{configurable:true,value:{getCurrentPosition:fn=>fn({coords:{latitude:24.9,longitude:67.1,accuracy:20}})}});
  const auth = {getSession:async()=>({data:{session:{user:{id:fixture.user}}}}),signOut:async()=>({error:null}),onAuthStateChange:fn=>{fixture.authChange=fn;return{data:{subscription:{unsubscribe(){}}}}}};
  function from(table) {
    const filters=[], query={};let start=0,end=Infinity;
    for(const method of ['select','order','limit'])query[method]=()=>query;
    query.eq=(k,v)=>{filters.push(row=>row[k]===v);return query;};
    query.in=(k,v)=>{filters.push(row=>v.includes(row[k]));return query;};
    query.gte=(k,v)=>{filters.push(row=>row[k]>=v);return query;};
    query.or=()=>{filters.push(row=>row.meta.cashReceived!==true);return query;};
    query.range=(a,b)=>{start=a;end=b;return query;};
    query.single=()=>result(true);
    query.then=(yes,no)=>result(false).then(yes,no);
    async function result(single){
      if(!fixture.online||fixture.failLoad)return{error:{message:'Failed to fetch'}};
      let rows=table==='profiles'?[{id:user,role:'rider',status:'active',rider_id:rider}]:table==='riders'?[{id:rider,name:'Karachi Rider',branch:'Karachi',meta:{}}]:table==='clients'?[{id:'client-1',name:'Shipper Store',address:'Pickup address, warehouse 5',phone:'02134567890',city:'Karachi'}]:fixture.rows;
      rows=rows.filter(row=>filters.every(f=>f(row))).slice(start,end+1);
      return{data:single?rows[0]:rows,error:null};
    }
    return query;
  }
  async function rpc(name,args={}) {
    fixture.requests.push({name,args});
    if(name==='rider_cash_summary')return{data:{...fixture.cash},error:null};
    if(name==='rider_station_view'){
      if(!fixture.online||fixture.failLoad)return{error:{message:'Failed to fetch'}};
      const C=['lahore'],o=p=>String(p.meta.pickupCity||'Karachi').toLowerCase(),d=p=>String(p.city).toLowerCase();
      const bucket=p=>{const s=p.status,O=C.includes(o(p)),D=C.includes(d(p));
        if(s==='New booked'&&O)return'pickup';
        if(['Parcel now in transit','Collected by rider','Arrived at warehouse'].includes(s)&&D&&!O)return'incoming';
        if(s==='Return in transit'&&O)return'incoming';
        if(['Collected by rider','Arrived at warehouse'].includes(s)&&O&&!D)return'transit';
        if(s==='Ready for return'&&D&&!O)return'transit';
        if(['Parcel received at destination','Refused','Consignee not available','Reattempt','Reassigned'].includes(s)&&D)return'station';
        if(s==='Return received at origin'&&O)return'station';
        if(['Parcel out for delivery','Return out for delivery'].includes(s)&&p.rider_id===rider)return'out';
        if(s==='Delivered'&&p.rider_id===rider)return'done';return null;};
      const parcels=fixture.rows.map(p=>({...p,origin:o(p).replace(/^./,c=>c.toUpperCase()),bucket:bucket(p),attempts:p.attempts||0,shipper:{name:'Shipper Store',phone:'02134567890',address:'Pickup address, warehouse 5'}})).filter(p=>p.bucket);
      return{data:{rider:{id:rider,name:'Lahore Rider',cities:['Lahore'],cash_limit:0},parcels,batches:fixture.batches||[]},error:null};
    }
    const requestKey=args.p_batch_key||args.p_key;
    if(fixture.saved.has(requestKey))return{data:fixture.saved.get(requestKey)};
    if(fixture.failRpc==='network')return{error:{message:'Failed to fetch'}};
    if(fixture.failRpc==='reject')return{error:{message:'Not assigned to you',code:'P0001'}};
    let result;
    if(name==='rider_batch_update_status'){
      const rows=args.p_awbs.map(awb=>fixture.rows.find(p=>p.awb===awb));
      if(rows.some(p=>!p))return{error:{message:'Not assigned to you',code:'P0001'}};
      for(const p of rows){p.status=args.p_to;p.updated_at=now;if(args.p_to==='Delivered')p.delivered_at=now;}
      result={count:rows.length,moved:args.p_awbs,status:args.p_to};
    }else if(name==='rider_station_action'){
      const map={collect:'Collected by rider',receive:'Parcel received at destination',out:'Parcel out for delivery',delivered:'Delivered',reattempt:'Reattempt',refused:'Refused',not_available:'Consignee not available',transit:'Parcel now in transit'};
      if(args.p_action==='transit'&&!(args.p_extra&&args.p_extra.reference))return{error:{message:'Enter the bus or courier reference (bilty number).',code:'P0001'}};
      const rows=args.p_awbs.map(awb=>fixture.rows.find(p=>p.awb===awb));
      if(rows.some(p=>!p))return{error:{message:'no such AWB',code:'P0001'}};
      for(const p of rows){p.status=map[args.p_action];p.rider_id=rider;p.updated_at=now;if(p.status==='Delivered')p.delivered_at=now;}
      result={action:args.p_action,count:rows.length,moved:args.p_awbs,batch:args.p_action==='transit'?'LAH-KAR-0930-01':null};
    }else if(name==='rider_swap_complete'){
      const p=fixture.rows.find(r=>r.awb===args.p_out_awb);if(!p)return{error:{message:'Not assigned to you',code:'P0001'}};
      p.status=args.p_outcome==='exchanged'?'Delivered':'Refused';p.updated_at=now;
      result={outcome:args.p_outcome,code:'SW-0001',out_awb:p.awb,back_awb:'N9999999',moved:[p.awb]};
    }else if(name==='rider_add_expense')result={id:requestKey,amount:args.p_amount};
    else result={net:args.p_expected_net,count:1,batch:requestKey};
    fixture.saved.set(requestKey,result);
    if(fixture.failRpc==='afterCommit')return{error:{message:'Network response lost'}};
    return{data:result,error:null};
  }
  window.supabase={createClient:()=>({auth,from,rpc,channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel:async()=>{}})};
  window.scrollTo=()=>{};
  return fixture;
}
