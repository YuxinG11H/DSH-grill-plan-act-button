import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isReadOnlyCommand, denyReason } from '../lib/inject.mjs'
import { checkRequest } from '../lib/request-policy.mjs'

for(const command of ['pwd','ls','ls lib','cat README.md','git status','git status --short','git log --oneline','git branch --list']){
 assert.equal(isReadOnlyCommand(command),true,command)
}
for(const command of ['git branch -D release','find . -delete','find . -exec rm x ;','ls\necho unsafe','ls\r\ndel file','git diff --output=out.txt','rg --pre malicious pattern','cat file > out','ls && rm file','ls & rm file','ls;rm file','ls $(touch file)','ls `touch file`']){
 assert.equal(isReadOnlyCommand(command),false,command)
 assert(denyReason('plan','ops_bash',{command}),command)
}
assert.equal(denyReason('standard','ops_bash',{command:'echo ok'}),null)
assert.equal(checkRequest({method:'GET',headers:{}}),null)
assert.equal(checkRequest({method:'POST',headers:{'content-type':'application/json',origin:'dsh-app://app'}}),null)
assert.equal(checkRequest({method:'GET',headers:{host:'127.0.0.1:19387',origin:'http://127.0.0.1:19387'}}),null)
assert.equal(checkRequest({method:'POST',headers:{'content-type':'text/plain'}}).status,415)
assert.equal(checkRequest({method:'POST',headers:{'content-type':'application/json',origin:'https://untrusted.example',host:'127.0.0.1:19387'}}).status,403)
assert.equal(checkRequest({method:'GET',headers:{origin:'https://untrusted.example'}}).status,403)
assert.equal(checkRequest({method:'POST',headers:{origin:'null','content-type':'application/json'}}).status,403)
assert.equal(checkRequest({method:'DELETE',headers:{}}).status,405)

const root=new URL('../',import.meta.url)
const pkg=JSON.parse(fs.readFileSync(new URL('package.json',root),'utf8'))
const manifest=JSON.parse(fs.readFileSync(new URL('dsh-plugin.json',root),'utf8'))
assert.equal(pkg.version,manifest.version)
for(const asset of ['限制模式.png','grill模式.png','plan模式.png','标准模式.png','限制模式激活中.png','grill模式激活中.png','plan模式激活中.png','标准模式激活中.png']){
 assert(fs.statSync(new URL('assets/'+asset,root)).size>0,asset)
}
for(const doc of ['LICENSE','NOTICE.md','README.md','CHANGELOG.md'])assert(fs.existsSync(new URL(doc,root)),doc)
const host=fs.readFileSync(new URL('lib/index.js',root),'utf8')
assert(!host.includes("'Access-Control-Allow-Origin': '*'"))
assert(!host.includes('latestAgentId'))
assert(!/[A-Z]:\\\\/.test(host),'No machine-specific Windows paths in runtime host')
assert(host.includes('const failure = checkRequest(req)'))
assert(host.includes("process.env.DSH_MODE_DEBUG !== '1'"))
console.log('PASS conservative shell classifier, cross-origin/JSON protection, packaged artwork, version/license consistency and no machine-bound host fallback')
