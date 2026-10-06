import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import type { DiskInfo, GpuInfo, ProcessInfo, ResourceSnapshot } from '../shared/types';

const SAMPLE_MS = 5000;
const HISTORY = 120; // 10 minutes
/** keep sampling this long after the last request, then go quiet */
const IDLE_STOP_MS = 2 * 60_000;

type CpuTimes = { idle: number; total: number }[];

/**
 * Samples CPU, memory, GPU (nvidia-smi), disks and the busiest processes.
 * Only runs while someone is looking: each `get()` keeps it alive for a while.
 */
export class ResourceMonitor {
  private timer?: NodeJS.Timeout;
  private lastAsk = 0;
  private prevCpu?: CpuTimes;
  private prevProc = new Map<number, number>();
  private prevProcAt = 0;
  private latest?: ResourceSnapshot;
  private history: ResourceSnapshot['history'] = [];
  private nvidia: 'unknown' | 'yes' | 'no' = 'unknown';
  private sampling?: Promise<void>;

  async get(): Promise<ResourceSnapshot> {
    this.lastAsk = Date.now();
    if (!this.timer) {
      // CPU % (machine and per process) needs two readings: take a baseline first
      this.prevCpu = cpuTimes();
      if (process.platform === 'linux') this.procLinux();
      await new Promise((r) => setTimeout(r, 500));
      await this.sample();
      this.timer = setInterval(() => {
        if (Date.now() - this.lastAsk > IDLE_STOP_MS) return this.stop();
        void this.sample();
      }, SAMPLE_MS);
      this.timer.unref();
    }
    if (this.sampling) await this.sampling;
    return { ...this.latest!, history: this.history };
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private sample(): Promise<void> {
    if (this.sampling) return this.sampling;
    this.sampling = (async () => {
      try {
        const cpu = this.cpu();
        const memory = memoryInfo();
        const [gpu, processes] = await Promise.all([this.gpus(), this.processes()]);
        const at = new Date().toISOString();
        const busiest = gpu.gpus.length ? gpu.gpus.reduce((a, b) => (b.util > a.util ? b : a)) : undefined;
        this.history.push({
          at,
          cpu: round(cpu.percent),
          mem: round((memory.used / memory.total) * 100),
          gpu: busiest?.util,
          gpuMem: busiest && busiest.memTotal ? round((busiest.memUsed / busiest.memTotal) * 100) : undefined,
        });
        if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
        this.latest = {
          at,
          host: os.hostname(),
          platform: `${os.type()} ${os.release()}`,
          uptimeSec: Math.round(os.uptime()),
          cpu,
          memory,
          gpus: gpu.gpus,
          gpuNote: gpu.note,
          disks: disks(),
          processes,
          history: [],
        };
      } finally {
        this.sampling = undefined;
      }
    })();
    return this.sampling;
  }

  private cpu(): ResourceSnapshot['cpu'] {
    const now = cpuTimes();
    const prev = this.prevCpu ?? now;
    this.prevCpu = now;
    const perCore = now.map((c, i) => {
      const p = prev[i] ?? c;
      const total = c.total - p.total;
      return total > 0 ? round(100 * (1 - (c.idle - p.idle) / total)) : 0;
    });
    const percent = perCore.length ? round(perCore.reduce((a, b) => a + b, 0) / perCore.length) : 0;
    const cpus = os.cpus();
    return {
      model: cpus[0]?.model?.trim() ?? 'CPU',
      cores: cpus.length,
      percent,
      perCore,
      load: process.platform === 'win32' ? undefined : (os.loadavg().map(round) as [number, number, number]),
    };
  }

  private async gpus(): Promise<{ gpus: GpuInfo[]; note?: string }> {
    if (this.nvidia === 'no') return { gpus: [], note: 'nvidia-smi not found' };
    try {
      const [main, apps] = await Promise.all([
        run('nvidia-smi', ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,uuid', '--format=csv,noheader,nounits']),
        run('nvidia-smi', ['--query-compute-apps=gpu_uuid,pid,process_name,used_memory', '--format=csv,noheader,nounits']).catch(() => ''),
      ]);
      this.nvidia = 'yes';
      const procs = csv(apps).map(([uuid, pid, name, mem]) => ({ uuid, pid: Number(pid), name: baseName(name), mem: mib(mem) }));
      const gpus = csv(main).map(([index, name, util, used, total, temp, power, limit, uuid]) => ({
        index: Number(index),
        name,
        util: numOr(util, 0),
        memUsed: mib(used),
        memTotal: mib(total),
        tempC: numOr(temp),
        powerW: numOr(power),
        powerLimitW: numOr(limit),
        processes: procs.filter((p) => p.uuid === uuid).map(({ uuid: _u, ...p }) => p),
      }));
      return { gpus };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.nvidia = 'no';
        return { gpus: [], note: 'nvidia-smi not found' };
      }
      return { gpus: [], note: String((e as Error).message).split('\n')[0] };
    }
  }

  private async processes(): Promise<ProcessInfo[]> {
    let all: ProcessInfo[] = [];
    try {
      if (process.platform === 'linux') all = this.procLinux();
      else if (process.platform === 'darwin') all = parsePs(await run('ps', ['-Ao', 'pid=,pcpu=,rss=,comm=']));
      else if (process.platform === 'win32') all = parseTasklist(await run('tasklist', ['/fo', 'csv', '/nh']));
    } catch {
      return [];
    }
    // the busiest by CPU and by memory, so the UI can sort either way
    const byCpu = [...all].sort((a, b) => b.cpu - a.cpu).slice(0, 12);
    const byMem = [...all].sort((a, b) => b.rss - a.rss).slice(0, 12);
    return [...new Map([...byCpu, ...byMem].map((p) => [p.pid, p])).values()];
  }

  /** CPU % from /proc/<pid>/stat deltas between samples (no `ps` spawn every 5 s). */
  private procLinux(): ProcessInfo[] {
    const now = Date.now();
    const dt = (now - this.prevProcAt) / 1000;
    const next = new Map<number, number>();
    const out: ProcessInfo[] = [];
    const page = 4096;
    const hz = 100;
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      const pid = Number(d);
      let stat: string;
      try {
        stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      } catch {
        continue;
      }
      const close = stat.lastIndexOf(')');
      const comm = stat.slice(stat.indexOf('(') + 1, close);
      const f = stat.slice(close + 2).split(' ');
      const ticks = Number(f[11]) + Number(f[12]); // utime + stime
      const rss = Number(f[21]) * page;
      next.set(pid, ticks);
      const prev = this.prevProc.get(pid);
      const cpu = prev !== undefined && dt > 0 ? round(((ticks - prev) / hz / dt) * 100) : 0;
      if (rss <= 0) continue; // kernel threads
      let name = comm;
      let agent = agentOf(comm);
      if (!agent && /^(node|bun|python3?)$/.test(comm)) {
        // CLIs run under node show up as "node": look at the script path
        try {
          const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').slice(0, 3).join(' ');
          agent = agentOf(cmd);
          if (agent) name = `${comm} (${agent})`;
        } catch {
          /* gone */
        }
      }
      out.push({ pid, name, cpu, rss, agent });
    }
    this.prevProc = next;
    this.prevProcAt = now;
    return out;
  }
}

function cpuTimes(): CpuTimes {
  return os.cpus().map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
}

function memoryInfo(): ResourceSnapshot['memory'] {
  const total = os.totalmem();
  if (process.platform === 'linux') {
    try {
      const m = Object.fromEntries(
        fs
          .readFileSync('/proc/meminfo', 'utf8')
          .split('\n')
          .map((l) => /^(\w+):\s+(\d+)/.exec(l))
          .filter((x): x is RegExpExecArray => !!x)
          .map((x) => [x[1], Number(x[2]) * 1024]),
      );
      // MemAvailable counts reclaimable cache; "free" alone would make the box look full
      const available = m.MemAvailable ?? os.freemem();
      return { total, used: total - available, available, swapTotal: m.SwapTotal, swapUsed: m.SwapTotal - m.SwapFree };
    } catch {
      /* fall through */
    }
  }
  const free = os.freemem();
  return { total, used: total - free, available: free };
}

const VIRTUAL_FS = /^(proc|sysfs|tmpfs|devtmpfs|devpts|cgroup2?|securityfs|pstore|efivarfs|bpf|debugfs|tracefs|configfs|fusectl|mqueue|hugetlbfs|autofs|binfmt_misc|squashfs|overlay|nsfs|ramfs|rpc_pipefs|fuse\.portal|fuse\.gvfsd-fuse|fuse\.snapfuse)$/;

function disks(): DiskInfo[] {
  const mounts: { mount: string; fs?: string; dev?: string }[] = [];
  if (process.platform === 'linux') {
    try {
      for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
        const [dev, mount, type] = line.split(' ');
        if (!mount || VIRTUAL_FS.test(type) || mount.startsWith('/snap/') || mount.startsWith('/boot/efi')) continue;
        if (!dev.startsWith('/dev/') && !/^(zfs|btrfs|nfs4?|cifs|fuse\..*)$/.test(type)) continue;
        mounts.push({ mount: mount.replace(/\\040/g, ' '), fs: type, dev });
      }
    } catch {
      mounts.push({ mount: '/' });
    }
  } else if (process.platform === 'win32') {
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${l}:\\`)) mounts.push({ mount: `${l}:\\` });
  } else {
    mounts.push({ mount: '/' });
    try {
      for (const v of fs.readdirSync('/Volumes')) mounts.push({ mount: `/Volumes/${v}` });
    } catch {
      /* none */
    }
  }
  const seen = new Set<string>();
  const out: DiskInfo[] = [];
  for (const m of mounts) {
    try {
      const s = fs.statfsSync(m.mount);
      const total = s.blocks * s.bsize;
      if (!total) continue;
      // one entry per device (bind mounts and subvolumes repeat it)
      const key = m.dev ?? `${total}:${s.bfree}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ mount: m.mount, fs: m.fs, total, used: total - s.bfree * s.bsize, free: s.bavail * s.bsize });
    } catch {
      /* unreadable mount */
    }
  }
  return out.sort((a, b) => b.total - a.total);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 4000, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const csv = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(',').map((x) => x.trim()));

export function parsePs(out: string): ProcessInfo[] {
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => {
      const name = baseName(m[4]);
      return { pid: Number(m[1]), cpu: Number(m[2]), rss: Number(m[3]) * 1024, name, agent: agentOf(m[4]) };
    });
}

function parseTasklist(out: string): ProcessInfo[] {
  return out
    .split('\n')
    .map((l) => /^"([^"]+)","(\d+)","[^"]*","\d+","([\d.,\s]+)\s*K"/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[2]), name: m[1], cpu: 0, rss: Number(m[3].replace(/[^\d]/g, '')) * 1024, agent: agentOf(m[1]) }));
}

function agentOf(s: string): ProcessInfo['agent'] {
  if (/(^|[/\\\s])claude(\.exe)?(\s|$)|@anthropic-ai[/\\]claude-code/.test(s)) return 'claude';
  if (/(^|[/\\\s])codex(\.exe)?(\s|$)|@openai[/\\]codex/.test(s)) return 'codex';
  return undefined;
}

const baseName = (p: string) => p.split(/[/\\]/).pop() || p;
const mib = (v: string) => numOr(v, 0) * 1024 * 1024;
const numOr = <T extends number | undefined = undefined>(v: string | undefined, d?: T): number | T => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : (d as T);
};
const round = (n: number) => Math.round(n * 10) / 10;
