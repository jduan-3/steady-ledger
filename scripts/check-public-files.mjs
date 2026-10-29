import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const privatePath=/(^|\/)(?:data|work|output|outputs|node_modules|\.playwright-cli|\.codex|\.agents|\.venv)(?:\/|$)|(?:^|\/)\.env(?:$|\.(?!example$))|\.(?:sqlite[^/]*|db(?:-[^/]*)?|key|pem|p12|pfx|bak|backup|zip|tar(?:\.gz)?|log)$/i;
const secrets=[
  /\bsk-[A-Za-z0-9_-]{24,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
  /\/Users\/[A-Za-z0-9._-]+\//g,
  /\/home\/[A-Za-z0-9._-]+\//g
];
export function inspectPublicFile(path,content='') {
  const problems=[];
  if(privatePath.test(path))problems.push('private data or runtime file');
  for(const pattern of secrets){pattern.lastIndex=0;if(pattern.test(content))problems.push('credential or personal machine path');}
  return problems;
}
export function checkPublicFiles() {
  const tracked=new Set(execFileSync('git',['ls-files','--cached','-z'],{encoding:'utf8'}).split('\0').filter(Boolean));
  const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean))];
  const failures=[];
  for(const path of files) {
    const contents=[];
    try{contents.push(readFileSync(path,'utf8'));}catch{}
    if(tracked.has(path))contents.push(execFileSync('git',['show',':'+path],{encoding:'utf8',maxBuffer:4e6}));
    const problems=[...new Set([inspectPublicFile(path),...contents.map(content=>inspectPublicFile(path,content))].flat())];
    if(problems.length)failures.push({path,problems});
  }
  return {files:files.length,failures};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const result=checkPublicFiles();
  if(result.failures.length){for(const item of result.failures)console.error(`${item.path}: ${item.problems.join(', ')}`);process.exitCode=1;}
  else console.log(`Public-file check passed (${result.files} files).`);
}
