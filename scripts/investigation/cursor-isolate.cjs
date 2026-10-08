const fs=require('node:fs');const promises=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {syncBuiltinESMExports}=require('node:module');
const targets=new Set([path.join(os.homedir(),'.cursor','hooks.json'),path.join(os.homedir(),'.claude','settings.json')]);
function isolated(file){try{return targets.has(path.resolve(file instanceof URL?require('node:url').fileURLToPath(file):String(file)));}catch{return false;}}
function contents(options){return typeof options==='string'||options?.encoding?'{}':Buffer.from('{}');}
const sync=fs.readFileSync;fs.readFileSync=function(file,options){return isolated(file)?contents(options):sync.apply(this,arguments);};
const read=fs.readFile;fs.readFile=function(file,options,callback){if(!isolated(file))return read.apply(this,arguments);if(typeof options==='function'){callback=options;options=undefined;}queueMicrotask(()=>callback(null,contents(options)));};
const asyncRead=promises.readFile;promises.readFile=async function(file,options){return isolated(file)?contents(options):asyncRead.apply(this,arguments);};
fs.promises.readFile=promises.readFile;syncBuiltinESMExports();
