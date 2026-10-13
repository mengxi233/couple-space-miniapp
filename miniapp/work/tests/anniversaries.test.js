const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
let definition,respond,toast,requested
let subscriptionCallbacks
const wxMock={showToast:value=>toast=value.title,navigateTo(){},showModal(){},
  requestSubscribeMessage:options=>{subscriptionCallbacks=options},
  getAccountInfoSync:()=>({miniProgram:{envVersion:'trial'}})}
vm.runInNewContext(fs.readFileSync('pages/anniversaries/anniversaries.js','utf8'),{
  Page:value=>definition=value,
  require:name=>name.endsWith('/anniversary-time')?require('../../services/anniversary-time'):{request:(path,options)=>{requested={path,options};return respond(path,options)}},
  setInterval:()=>1,clearInterval:()=>{},
  wx:wxMock
})
function page(){
  const instance={...definition,data:structuredClone(definition.data)}
  instance.setData=values=>{for(const [key,value]of Object.entries(values)){
    const bits=key.split('.');if(bits.length===2)instance.data[bits[0]][bits[1]]=value;else instance.data[key]=value
  }}
  return instance
}
async function main(){
  const p=page();p.data.canEdit=true;p.add()
  assert.equal(p.data.form.reminderTime,'10:00')
  assert.deepEqual(Array.from(p.data.form.reminderDays),[7,3,1,0])
  p.title({detail:{value:'伴侣生日'}});p.kind({detail:{value:'1'}})
  assert.equal(p.data.form.calendarType,'lunar');assert.equal(p.data.days.length,30)
  p.data.years='bad';await p.save();assert.ok(toast.includes('年份'))
  p.data.years='';p.load=async()=>{}
  respond=()=>Promise.reject(new Error('保存失败'))
  await p.save();assert.equal(p.data.editing,true);assert.equal(p.data.saving,false)
  respond=()=>Promise.resolve({id:1});await p.save()
  assert.equal(requested.options.data.startYear,null);assert.equal(p.data.editing,false)
  const q=page()
  respond=path=>Promise.resolve(path.endsWith('/settings')?{email:'a@example.com',emailEnabled:true,smtpConfigured:false,deliveries:[]}:{items:[],canEdit:true})
  await q.load();assert.equal(q.data.mail.smtpConfigured,false);assert.equal(q.data.canEdit,true)
  respond=()=>Promise.reject(new Error('请先登录'));await q.load()
  assert.equal(q.data.canEdit,false);assert.equal(q.data.items.length,0)
  const clockPage=page();clockPage.visible=true
  clockPage.data.items=[{id:1,eventKind:'birthday',nextDate:'2027-12-10'},
    {id:2,eventKind:'anniversary',nextDate:'2027-10-21',elapsedFrom:'2025-10-21T00:00:00+08:00'}]
  clockPage.startClock()
  assert.equal(clockPage.data.clocks[1].text,undefined)
  assert.ok(clockPage.data.clocks[1].remaining.text)
  assert.ok(clockPage.data.clocks[2].text)
  assert.ok(clockPage.data.clocks[2].remaining.text)
  assert.equal(clockPage.clockTimer,1)
  clockPage.onHide();assert.equal(clockPage.clockTimer,null)
  clockPage.onUnload();assert.equal(clockPage.closed,true)
  const w=page();w.data.mail.wechat={configured:true,templateId:'verified-template'};w.load=async()=>{}
  let calls=0
  respond=()=>{calls++;return Promise.resolve({success:true})}
  w.subscribeWechat()
  assert.equal(calls,0) // Authorization happens directly on tap, not after a network request.
  assert.equal(w.data.subscribing,true)
  await subscriptionCallbacks.success({'verified-template':'reject'})
  assert.equal(calls,0);assert.equal(w.data.subscribing,false)
  w.subscribeWechat();await subscriptionCallbacks.success({'verified-template':'accept'})
  assert.equal(calls,1);assert.equal(requested.options.data.state,'trial')
  assert.equal(requested.options.data.templateId,'verified-template')
  assert.equal(w.data.subscribing,false)
  w.subscribeWechat();subscriptionCallbacks.fail()
  assert.equal(w.data.subscribing,false)
  await w.disableWechat();assert.equal(requested.options.data.enabled,false)
  const manifest=JSON.parse(fs.readFileSync('app.json','utf8'))
  assert.ok(fs.readFileSync('pages/anniversaries/anniversaries.wxml','utf8').includes("item.eventKind !== 'birthday'"))
  assert.ok(manifest.pages.includes('pages/anniversaries/anniversaries'))
  console.log('Anniversary frontend tests passed: defaults, lunar editor, save recovery, SMTP status and permission failures.')
}
main().catch(error=>{console.error(error);process.exitCode=1})
