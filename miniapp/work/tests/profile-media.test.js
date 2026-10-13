const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
let definition, requestImpl, uploadImpl, toast, selected, uploadCalls = 0
const app = { globalData: {} }
const wx = { showToast: value => { toast=value.title }, setStorageSync() {}, redirectTo() {},
  chooseMedia: options => options.success(selected) }
function page(path) {
  vm.runInNewContext(fs.readFileSync(path,'utf8'), { getApp: () => app, Page: value => { definition=value }, wx,
    require: () => ({ request: (...args) => requestImpl(...args), upload: (...args) => { uploadCalls++; return uploadImpl(...args) } }) })
  const result={...definition,data:structuredClone(definition.data)}
  result.setData=patch => { for(const [key,value] of Object.entries(patch)) {
    const parts=key.split('.'); if(parts.length===2) result.data[parts[0]][parts[1]]=value; else result.data[key]=value
  } }
  return result
}
const flush=()=>new Promise(resolve=>setImmediate(resolve))
async function main() {
  const profile=page('pages/profile-edit/profile-edit.js')
  profile.data.ready=true; profile.data.nickname='我的名字'
  uploadImpl=()=>Promise.reject(new Error('上传失败'))
  await profile.uploadAvatar('wxfile://temporary')
  assert.equal(profile.data.avatarUrl,'')
  uploadImpl=()=>Promise.resolve({url:'https://example.com/avatar.png'})
  await profile.uploadAvatar('wxfile://temporary')
  assert.equal(profile.data.avatarUrl,'https://example.com/avatar.png')
  requestImpl=()=>{throw Error('invalid QQ must not issue a request')}
  profile.data.qq='abc'; profile.fetchQQ()
  assert.equal(toast,'请输入5至12位QQ号')
  requestImpl=(_path, options)=>Promise.resolve({user:options.data})
  profile.save(); await flush()
  assert.equal(app.globalData.user.nickname,'我的名字')
  assert.equal(app.globalData.user.avatarUrl,'https://example.com/avatar.png')

  const editor=page('pages/timeline-event/timeline-event.js')
  const before=uploadCalls
  selected={tempFiles:[{size:10*1024*1024+1,tempFilePath:'too-large'}]}
  editor.addVideo(); assert.equal(uploadCalls,before)
  selected={tempFiles:[{size:1024,tempFilePath:'video.mp4'}]}
  uploadImpl=(path,_file,options)=>{
    assert.equal(path,'/uploads/videos'); assert.equal(options.timeout,120000)
    return Promise.resolve({url:'https://example.com/video.mp4'})
  }
  editor.addVideo(); await flush()
  assert.equal(editor.data.form.videoUrl,'https://example.com/video.mp4')
  assert.equal(editor.data.uploading,false)
  editor.clearVideo(); assert.equal(editor.data.form.videoUrl,'')
  console.log('Profile and video tests passed: avatar persistence, QQ validation, profile save, video size and upload.')
}
main().catch(error=>{ console.error(error);process.exitCode=1 })
