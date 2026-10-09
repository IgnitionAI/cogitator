#!/usr/bin/python3
"""Read-only service metadata inventory. No service config files or credentials read."""
import sys
sys.dont_write_bytecode = True

import json
import os
import re
import subprocess

DOCKER = ['/usr/bin/docker', '--host=unix:///var/run/docker.sock', '--config=/proc/self']
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'HOME': '/'}
TEMPLATE = '''{"id":{{json .Id}},"image":{{json .Config.Image}},"config_digest":{{json .Image}},"user":{{json .Config.User}},"readonly_rootfs":{{json .HostConfig.ReadonlyRootfs}},"cap_add":{{json .HostConfig.CapAdd}},"cap_drop":{{json .HostConfig.CapDrop}},"security_options":{{json .HostConfig.SecurityOpt}},"port_bindings":{{json .HostConfig.PortBindings}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"source":{{json $m.Source}},"destination":{{json $m.Destination}},"type":{{json $m.Type}},"read_only":{{not $m.RW}}}{{end}}]}'''


def run(args):
    try:
        result = subprocess.run(args, env=ENV, cwd='/', stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=15, check=True, text=True)
        # ponytail: capture then check is for small local inventories; stream-cap if hosts grow.
        if len(result.stdout) <= 262144:
            return result.stdout
    except (OSError, subprocess.SubprocessError, UnicodeError):
        pass
    return None


def inventory(command=run):
    report = {'scope': 'local_read_only_metadata', 'effective_config': 'not_inspected',
              'mfa_proven': False, 'oidc_proven': False, 'containers': []}
    output = command(DOCKER + ['ps', '--all', '--no-trunc', '--format',
                               '{{json .ID}}\t{{json .Names}}\t{{json .Image}}\t{{json .Ports}}'])
    report['docker_status'] = 'available' if output is not None else 'unknown'
    for line in (output or '').splitlines():
        try:
            ident, name, image, ports = [json.loads(p) for p in line.split('\t')]
            if not all(isinstance(v, str) for v in (ident, name, image, ports)):
                raise ValueError()
            if not re.fullmatch(r'[0-9a-f]{64}', ident):
                raise ValueError()
            actual = bool(re.fullmatch(r'(?:(?:docker.io|ghcr.io)/)?authelia/authelia(?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?', image))
            published = bool(re.search(r':9091->', ports))
            if not actual and not published:
                continue
            detail = command(DOCKER + ['inspect', '--type=container', '--format', TEMPLATE, ident])
            meta = json.loads(detail) if detail else None
            if not isinstance(meta, dict) or set(meta) != {'id', 'image', 'config_digest', 'user',
                    'readonly_rootfs', 'cap_add', 'cap_drop', 'security_options', 'port_bindings', 'mounts'}:
                meta = None
            report['containers'].append({
                'id': ident, 'name': name, 'image': image, 'ports': ports,
                'classification': 'authelia_image_reference' if actual else 'port_9091_candidate_not_proven',
                'metadata': meta if meta is not None else 'unknown'})
        except (ValueError, TypeError):
            report['docker_status'] = 'partial_unknown'
    units = command(['/usr/bin/systemctl', 'list-units', '--all', '--type=service',
                     '--no-legend', '--no-pager', '--plain', 'authelia*.service'])
    report['native_status'] = 'available' if units is not None else 'unknown'
    report['native_units'] = []
    for line in (units or '').splitlines():
        unit = line.split()[0] if line.split() else ''
        if not re.fullmatch(r'authelia[\w@.-]*\.service', unit):
            report['native_status'] = 'partial_unknown'
            continue
        detail = command(['/usr/bin/systemctl', 'show', '--no-pager',
                          '--property=Id,User,ActiveState,MainPID,FragmentPath', unit])
        allowed = {'Id', 'User', 'ActiveState', 'MainPID', 'FragmentPath'}
        report['native_units'].append({k: v for k, sep, v in
            (row.partition('=') for row in (detail or '').splitlines()) if sep and k in allowed}
            if detail is not None else {'status': 'unknown'})
    return report


def main():
    if sys.platform != 'linux' or os.geteuid() != 0:
        print(json.dumps({'status': 'requires_linux_root'}))
        return 1
    print(json.dumps(inventory(), separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
