const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
let definition,fetches=0,timer,resolveList
const response={rooms:[],total:0,pageSize:20,stats:{rooms:0,members:0,online:0,spriteBytes:0,stateBytes:0,databaseBytes:4096,reusableBytes:0,journalBytes:0}}
const api={adminList:()=>{fetches++;return new Promise(resolve=>resolveList=resolve)}}
vm.runInNewContext(fs.readFileSync('pages/lightboard-admin/lightboard-admin.js','utf8'),{Page:d=>definition=d,require:()=>api,Date,setTimeout:fn=>{timer=fn;return 1},clearTimeout:()=>{timer=null},wx:{}})
async function main(){
 const p={...definition,data:{...definition.data},setData(d){Object.assign(this.data,d)}}
 p.onShow();assert.equal(fetches,1);resolveList(response);await new Promise(setImmediate)
 assert.equal(p.data.stats.databaseSize,'4.0 KB');assert.equal(p.data.pages,1);assert(timer)
 p.onHide();assert.equal(timer,null)
 p.onShow();p.onHide();resolveList({...response,total:9});await new Promise(setImmediate);assert.equal(timer,null);assert.equal(p.data.pages,1)
 p.onUnload()
 let profile,resolveAccess
 const app={globalData:{token:'active-session'}}
 vm.runInNewContext(fs.readFileSync('pages/profile/profile.js','utf8'),{getApp:()=>app,Page:d=>profile=d,wx:{getStorageSync:()=>'',removeStorageSync(){},showToast(){}},require:name=>name.endsWith('/config')?require('../../config'):({request:()=>new Promise(resolve=>resolveAccess=resolve)})})
 const q={...profile,data:{...profile.data},setData(d){Object.assign(this.data,d)}}
 q.loadRoomAccess();resolveAccess({canManage:true});await new Promise(setImmediate);assert.equal(q.data.canManageRooms,true)
 q.loadRoomAccess();q.logout();resolveAccess({canManage:true});await new Promise(setImmediate);assert.equal(q.data.canManageRooms,false)
 console.log('Room admin passed: metric formatting, refresh cancellation, permission-gated entry, logout race.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
