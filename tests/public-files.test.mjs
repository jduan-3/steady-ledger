import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPublicFile } from '../scripts/check-public-files.mjs';

test('开源检查拒绝数据、密钥、环境、截图、备份与运行文件，允许源码和虚构样例',()=>{
  for(const file of ['data/balance.sqlite','data/secret.key','work/screenshot.png','.playwright-cli/page.yml','.env','.env.production','balance.db-wal','backup.zip','server.log'])assert.ok(inspectPublicFile(file).length,file);
  for(const file of ['src/ai.mjs','.env.example','examples/demo-backup.json','public/favicon.svg'])assert.deepEqual(inspectPublicFile(file),[]);
});
test('开源检查识别凭据和个人机器路径，报告不包含原始秘密',()=>{
  for(const content of ['sk-'+ 'x'.repeat(32),'ghp_'+ 'x'.repeat(36),'github_pat_'+ 'x'.repeat(40),'-----BEGIN '+'PRIVATE KEY-----','/Users/'+'private-user/ledger','/home/'+'private-user/ledger']){
    const result=inspectPublicFile('src/example.mjs',content);assert.ok(result.length);assert.ok(!JSON.stringify(result).includes(content));
  }
});
