const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
const source=fs.readFileSync('services/lightboard-room.js','utf8')
function setup(stored){
 let result,issued=0,writes=0,seen=[]
 const token='ab'.repeat(32),wx={getStorageSync:()=>stored,setStorageSync:(key,value)=>{writes++;stored=value}}
 const request=async(path,options)=>{if(path.endsWith('/session')){issued++;return {token}}seen.push(options.header);return {}}
 vm.runInNewContext(source,{module:{set exports(v){result=v}},require:()=>({request,upload:async(path,file,options)=>{seen.push(options.header);return {}}}),wx})
 return {api:result,seen,stats:()=>({issued,writes}),token}
}
async function main(){
 const a=setup('')
 await Promise.all([a.api.create('sync',{}),a.api.action('room','join')])
 assert.equal(a.stats().issued,1);assert.equal(a.stats().writes,1)
 await a.api.uploadSprite({id:'room',version:1},'file.png')
 assert.equal(a.seen.length,3);assert(a.seen.every(h=>h['X-Lightboard-Guest']===a.token))
 const b=setup(a.token);await b.api.action('room','poll');assert.equal(b.stats().issued,0)
 assert.equal(b.seen[0]['X-Lightboard-Guest'],a.token)
 console.log('Guest identity passed: no login dependency, concurrent initialization, device persistence, upload authentication.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
