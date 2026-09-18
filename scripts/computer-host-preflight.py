#!/usr/bin/env python3
"""Read-only inventory. Run on a proposed Proxmox host; never changes guests or disks."""
import json,os,re,subprocess
from pathlib import Path

def run(args):
    p=subprocess.run(args,capture_output=True,text=True,timeout=30)
    return p.stdout.strip() if p.returncode==0 else None

def query(route):
    raw=run(['pvesh','get',route,'--output-format','json'])
    if raw is None:return None
    return json.loads(raw)

node=run(['hostname','-s']);pve=Path('/usr/bin/pveversion').exists()
if not node or not re.fullmatch(r'[A-Za-z0-9-]+',node):raise SystemExit('Invalid node name')
mem={k:int(v.strip().split()[0])*1024 for k,v in (line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines()) if k in ['MemTotal','MemAvailable']}
resources=query('/cluster/resources') if pve else []
local=[r for r in (resources or []) if r.get('node')==node and r.get('type') in ['qemu','lxc']]
storages=query('/nodes/'+node+'/storage') if pve else []
print(json.dumps({'node':node,'pve_version':run(['pveversion']) if pve else None,'kvm_available':Path('/dev/kvm').exists(),'logical_cpus':os.cpu_count(),'memory_bytes':mem,'configured_guest_memory_limit_bytes':sum(r.get('maxmem',0) for r in local),'configured_guest_vcpus':sum(r.get('maxcpu',0) for r in local),'guest_count':len(local),'storage':[{k:r.get(k)for k in ['storage','type','active','total','used','avail','content']}for r in (storages or [])],'ready_for_sales':False,'next_checks':['Confirm allocatable RAM, CPU and disk after existing workload and host reserves','Verify one isolated 8 GB / 150 GB desktop VM and AI session','Verify network isolation, remote access revocation and backup restore','Configure and verify computer subscription billing before enabling checkout']},indent=2))
