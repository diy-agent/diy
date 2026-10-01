import { RpcSchema, createTypedClient } from '../src/index';
import { httpHarness } from '../test/harness';
import { z } from 'zod';
const api=RpcSchema.router({echo:RpcSchema.unary({input:{v:z.number()},output:z.number()})});
async function main(){const {binding,client,dispose}=await httpHarness.start();const cli=createTypedClient(client,api);binding.on(api.echo,({input})=>input.v);client.dispose();try{const r=await cli.echo({v:1});console.log('[dispose-new-request]',r);console.error('FAIL: request after dispose succeeded');process.exitCode=1}catch(e:any){console.log('[dispose-new-request]',{name:e?.name,code:e?.code,message:e?.message});if(e?.code!=='DISPOSED'){console.error('FAIL: request after dispose did not use DISPOSED');process.exitCode=1}else console.log('PASS: disposed client rejects new request')}finally{await dispose()}}
main().catch(e=>{console.error(e);process.exitCode=1});
