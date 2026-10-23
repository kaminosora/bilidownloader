import { build } from 'esbuild';
import { mkdir, copyFile, cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
await mkdir('dist',{recursive:true});
for(const file of await readdir('static'))await cp(`static/${file}`,`dist/${file}`,{recursive:true});
await copyFile('manifest.json','dist/manifest.json');
await build({entryPoints:['src/background.js','src/offscreen.js','src/popup.js','src/tasks.js'],outdir:'dist',bundle:true,format:'esm',target:'chrome116',loader:{'.css':'text'},legalComments:'eof'});
await build({entryPoints:['src/content.js'],outdir:'dist',bundle:true,format:'iife',target:'chrome116',loader:{'.css':'text'},legalComments:'eof'});
await cp('node_modules/@ffmpeg/ffmpeg/dist/esm','dist/vendor/ffmpeg',{recursive:true});
await cp('node_modules/@ffmpeg/core/dist/esm','dist/vendor/core',{recursive:true});
await mkdir('dist/icons',{recursive:true});
function crc(b){let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(name,data){const n=Buffer.from(name),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([n,data])));return Buffer.concat([size,n,data,sum]);}
for(const size of [16,48,128]){
  const rows=Buffer.alloc(size*(1+size*4));
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const a=x/size,b=y/size;const white=(a>.43&&a<.57&&b>.19&&b<.57)||(b>.43&&b<.68&&Math.abs(a-.5)<(.68-b))||(b>.72&&b<.81&&a>.25&&a<.75);
    const o=y*(size*4+1)+1+x*4;rows.set(white?[255,255,255,255]:[245,85,132,255],o);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  await writeFile(`dist/icons/${size}.png`,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]));
}
for(const name of ['README.md','CHANGELOG.md','PRIVACY.md','THIRD_PARTY_NOTICES.md','LICENSE']){try{await copyFile(name,`dist/${name}`);}catch(e){if(e.code!=='ENOENT')throw e;}}
await mkdir('dist/docs',{recursive:true});
try{await copyFile('docs/TEST_REPORT.md','dist/docs/TEST_REPORT.md');}catch(e){if(e.code!=='ENOENT')throw e;}
console.log('Built locally loadable extension: dist/');
