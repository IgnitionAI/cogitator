"""Run: python3 -I scripts/vps-access/test_inspect.py (no Docker/root needed)."""
import sys
sys.dont_write_bytecode = True

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('inventory', Path(__file__).with_name('inspect.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)
ID = 'a' * 64
SECRET = 'SENTINEL_PASSWORD_CLIENT_SECRET_JWK'


def metadata(image, source='/never/read'):
    return {'id': ID, 'image': image, 'config_digest': 'sha256:' + ID, 'user': '1000',
            'readonly_rootfs': True, 'cap_add': None, 'cap_drop': ['ALL'],
            'security_options': ['no-new-privileges'], 'port_bindings': {},
            'mounts': [{'type': 'bind', 'source': source, 'destination': '/config', 'read_only': True}]}


class InventoryTests(unittest.TestCase):
    def test_pinned_image_never_reads_yaml_or_credentials(self):
        image = 'authelia/authelia:4.39.28@sha256:' + ID
        with tempfile.TemporaryDirectory() as directory:
            # Even resource-amplifying YAML must never be opened or parsed.
            Path(directory, 'configuration.yml').write_text('a: &a [' + SECRET + ']\nb: &b [*a, *a]\nc: [*b, *b]\n')
            def runner(args):
                if 'ps' in args:
                    return '\t'.join(map(json.dumps, [ID, 'idp', image, '']))
                if 'inspect' in args:
                    return json.dumps(metadata(image, directory))
                return ''
            with patch('builtins.open') as opened, patch.object(inventory.os, 'open') as os_open:
                report = inventory.inventory(runner)
                opened.assert_not_called()
                os_open.assert_not_called()
            self.assertEqual(report['containers'][0]['classification'], 'authelia_image_reference')
            self.assertEqual(report['effective_config'], 'not_inspected')
            self.assertNotIn('candidate_config', report['containers'][0])
            self.assertNotIn(SECRET, json.dumps(report))
            self.assertFalse(report['mfa_proven'])
            self.assertFalse(report['oidc_proven'])

    def test_collision_and_command_allowlist(self):
        commands = []
        def runner(args):
            commands.append(args)
            if 'ps' in args:
                return '\t'.join(map(json.dumps, [ID, 'collision', 'example/not-authelia', '0.0.0.0:9091->80/tcp']))
            if 'inspect' in args:
                return json.dumps(metadata('example/not-authelia'))
            if 'list-units' in args:
                return 'authelia.service loaded active running\n--unsafe-' + SECRET
            return 'Id=authelia.service\nUser=authelia\nActiveState=active\nMainPID=1\nFragmentPath=/etc/systemd/system/authelia.service\nEnvironment=' + SECRET
        report = inventory.inventory(runner)
        self.assertEqual(report['containers'][0]['classification'], 'port_9091_candidate_not_proven')
        self.assertEqual(report['native_status'], 'partial_unknown')
        self.assertNotIn(SECRET, json.dumps(report))
        for args in commands:
            if args[0] == '/usr/bin/docker':
                self.assertEqual(args[:3], inventory.DOCKER)
                self.assertIn(args[3], ('ps', 'inspect'))
                for forbidden in ('Config.Env', 'Cmd', 'Args', 'Labels'):
                    self.assertNotIn(forbidden, ' '.join(args))
            else:
                self.assertEqual(args[0], '/usr/bin/systemctl')
                self.assertIn(args[1], ('list-units', 'show'))
                self.assertNotIn('ExecStart', ' '.join(args))

    def test_missing_or_unexpected_metadata_is_unknown(self):
        for detail in (None, json.dumps({'Env': SECRET}), '{invalid ' + SECRET):
            with self.subTest(detail=detail):
                def runner(args):
                    if 'ps' in args:
                        return '\t'.join(map(json.dumps, [ID, 'idp', 'authelia/authelia:4', '']))
                    return detail if 'inspect' in args else None
                report = inventory.inventory(runner)
                self.assertNotIn(SECRET, json.dumps(report))
                self.assertEqual(report['native_status'], 'unknown')
                if report['containers']:
                    self.assertEqual(report['containers'][0]['metadata'], 'unknown')
                else:
                    self.assertEqual(report['docker_status'], 'partial_unknown')

    def test_non_root_or_non_linux_cannot_scan(self):
        for platform, uid in (('darwin', 0), ('linux', 1000)):
            with patch.object(inventory.sys, 'platform', platform), patch.object(inventory.os, 'geteuid', return_value=uid), \
                    patch('builtins.print'), patch.object(inventory, 'inventory') as scan:
                self.assertEqual(inventory.main(), 1)
                scan.assert_not_called()

    def test_subprocess_errors_and_constraints(self):
        for error in (OSError(SECRET), inventory.subprocess.TimeoutExpired(['dummy'], 15, stderr=SECRET)):
            with patch.object(inventory.subprocess, 'run', side_effect=error) as process:
                self.assertIsNone(inventory.run(['/usr/bin/systemctl', 'list-units']))
                kwargs = process.call_args.kwargs
                self.assertEqual(kwargs['env'], inventory.ENV)
                self.assertEqual(kwargs['timeout'], 15)
                self.assertEqual(kwargs['stderr'], inventory.subprocess.DEVNULL)
                self.assertNotIn('shell', kwargs)


if __name__ == '__main__':
    unittest.main()
