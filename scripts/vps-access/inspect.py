#!/usr/bin/python3
"""Read-only local inventory. Candidate declarations are not effective configuration."""
import json
import os
import re
import stat
import subprocess
import sys

DOCKER = ['/usr/bin/docker', '--host=unix:///var/run/docker.sock', '--config=/proc/self']
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'HOME': '/'}
TEMPLATE = '''{"id":{{json .Id}},"image":{{json .Config.Image}},"config_digest":{{json .Image}},"user":{{json .Config.User}},"readonly_rootfs":{{json .HostConfig.ReadonlyRootfs}},"cap_add":{{json .HostConfig.CapAdd}},"cap_drop":{{json .HostConfig.CapDrop}},"security_options":{{json .HostConfig.SecurityOpt}},"port_bindings":{{json .HostConfig.PortBindings}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"source":{{json $m.Source}},"destination":{{json $m.Destination}},"type":{{json $m.Type}},"read_only":{{not $m.RW}}}{{end}}]}'''
POLICIES = {'deny', 'bypass', 'one_factor', 'two_factor'}


def run(args):
    try:
        result = subprocess.run(args, env=ENV, cwd='/', stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=15, check=True, text=True)
        if len(result.stdout) <= 262144:
            return result.stdout
    except (OSError, subprocess.SubprocessError, UnicodeError):
        pass
    return None


def mapping(value):
    return value if isinstance(value, dict) else {}


def policy(value):
    return value if isinstance(value, str) and value in POLICIES else 'unknown'


def declarations(data):
    if not isinstance(data, dict):
        return {'status': 'unknown'}
    auth = mapping(data.get('authentication_backend'))
    notifier = mapping(data.get('notifier'))
    oidc = mapping(data.get('identity_providers'))
    clients = mapping(oidc.get('oidc')).get('clients')
    counts = dict.fromkeys(sorted(POLICIES | {'unknown'}), 0)
    if isinstance(clients, list):
        for client in clients:
            counts[policy(mapping(client).get('authorization_policy'))] += 1
    domains = []
    session = mapping(data.get('session'))
    cookies = session.get('cookies', [])
    values = [session.get('domain')] + ([mapping(c).get('domain') for c in cookies[:32]]
                                      if isinstance(cookies, list) else [])
    for domain in values:
        if (isinstance(domain, str) and len(domain) <= 253 and
                re.fullmatch(r'\.?[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?', domain) and
                all(re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', p)
                    for p in domain.lstrip('.').split('.'))):
            domains.append(domain.lower())
    return {'status': 'declared_only',
            'authentication_backend': [k for k in ('file', 'ldap') if k in auth] or 'unknown',
            'default_policy': policy(mapping(data.get('access_control')).get('default_policy')),
            'notifier': [k for k in ('smtp', 'filesystem') if k in notifier] or 'unknown',
            'oidc_present': 'oidc' in oidc,
            'oidc_client_count': len(clients) if isinstance(clients, list) else 'unknown',
            'oidc_policy_counts': counts if isinstance(clients, list) else 'unknown',
            'cookie_domains': domains}


def candidate(directory, filename, loader):
    if loader is None:
        return {'status': 'unknown_no_parser'}
    fd = None
    try:
        # Walk without following even parent symlinks; never open other filenames.
        if not isinstance(directory, str) or not directory.startswith('/'):
            return {'status': 'unknown_unsafe_path'}
        parts = directory.split('/')[1:]
        if any(p in ('.', '..') for p in parts):
            return {'status': 'unknown_unsafe_path'}
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        for part in filter(None, parts):
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        info = os.stat(filename, dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 131072:
            return {'status': 'unknown_unsafe_file'}
        file_fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(file_fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 131072:
                return {'status': 'unknown_unsafe_file'}
            raw = stream.read(131073)
        if len(raw) > 131072:
            return {'status': 'unknown_unsafe_file'}
        return declarations(loader(raw))
    except Exception:
        return {'status': 'unknown_unavailable_or_invalid'}
    finally:
        if fd is not None:
            os.close(fd)


def inventory(command=run, loader=None):
    report = {'scope': 'local_read_only', 'effective_config': 'unknown',
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
            entry = {'id': ident, 'name': name, 'image': image, 'ports': ports,
                     'classification': 'authelia_image' if actual else 'port_9091_candidate_not_proven',
                     'metadata': meta if meta is not None else 'unknown'}
            # A port collision alone never authorizes reading configuration files.
            if actual and meta is not None:
                mounts = meta.get('mounts')
                binds = [m for m in mounts if isinstance(m, dict) and m.get('type') == 'bind'
                         and m.get('destination') == '/config'] if isinstance(mounts, list) else []
                entry['candidate_config'] = {name: candidate(binds[0].get('source'), name, loader)
                    for name in ('configuration.yml', 'configuration.yaml')} if len(binds) == 1 else 'unknown'
            report['containers'].append(entry)
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
    sys.dont_write_bytecode = True
    try:
        import yaml  # Optional existing installation only; no dependency installation.
        loader = yaml.safe_load
    except Exception:
        loader = None
    print(json.dumps(inventory(loader=loader), separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
