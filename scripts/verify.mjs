import { spawnSync } from 'node:child_process'
import path from 'node:path'
const root=path.resolve(import.meta.dirname,'..')
const checks=[
 ['--check','lib/index.js'],['--check','lib/client.js'],['--check','lib/inject.mjs'],
 ['--check','lib/state.mjs'],['--check','lib/session-core.mjs'],['--check','lib/plan-availability.mjs'],['--check','lib/request-policy.mjs'],
 ['scripts/test-client-contract.mjs'],['scripts/test-plan-availability.mjs'],['scripts/test-session-core.mjs'],['scripts/test-host-core.mjs'],['scripts/test-client-state.mjs'],['scripts/test-release-safety.mjs'],
]
for(const args of checks){
 console.log('\n> node '+args.join(' '))
 // Inherit stdio: do not spawn a captured pipe inside the DSH Windows sandbox.
 const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'})
 if(result.error){console.error(result.error.message);process.exit(1)}
 if(result.status!==0)process.exit(result.status||1)
}
console.log('\nAll release verification checks passed.')
