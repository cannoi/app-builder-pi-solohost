import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dockerStatus } from './modes.js';

const exec = promisify(execFile);

export class Sandbox {
  constructor({ cfg, log }) { this.cfg = cfg; this.log = log; }

  async run({ project, sourcePath, jobId }) {
    const st = dockerStatus(this.cfg.docker.mode);
    if (!st.usable) return { status:'skipped', health:false, tests:{passed:0,failed:0}, reason:'Sandbox container execution requires POWER mode.' };
    const safeId = String(jobId || 'job').toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,32);
    const name = `paf-sandbox-${safeId}`;
    const image = `paf-sandbox:${project.slug}-${safeId}`;
    const timeout = Math.min(this.cfg.limits.sandboxTimeoutSec, 600);
    const started = Date.now();
    try {
      await exec('docker', ['build','-t',image,'.'], { cwd:sourcePath, timeout:this.cfg.limits.buildTimeoutSec*1000, maxBuffer:2*1024*1024 });
      await exec('docker', ['run','-d','--rm','--name',name,'--network','bridge','--memory','256m','--cpus','0.5',image], { timeout:20000 });
      let health = false;
      let output = '';
      const deadline = Date.now() + timeout*1000;
      while (Date.now() < deadline) {
        try {
          const r = await exec('docker', ['exec',name,'node','-e',`fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`], {timeout:5000});
          output = r.stdout || '';
          health = true;
          break;
        } catch { await new Promise(r=>setTimeout(r,1500)); }
      }
      const logs = await exec('docker',['logs','--tail','120',name],{timeout:10000}).catch(e=>({stdout:'',stderr:e.message}));
      return { status:health?'passed':'failed', duration:Math.round((Date.now()-started)/1000), health, tests:{passed:health?1:0,failed:health?0:1}, logs:String((logs.stdout||'')+(logs.stderr||'')).slice(0,6000), image };
    } catch (err) {
      return { status:'failed', duration:Math.round((Date.now()-started)/1000), health:false, tests:{passed:0,failed:1}, logs:String(err.stderr||err.message).slice(0,6000), image };
    } finally {
      await exec('docker',['rm','-f',name],{timeout:10000}).catch(()=>{});
      await exec('docker',['rmi','-f',image],{timeout:20000}).catch(()=>{});
    }
  }
}
