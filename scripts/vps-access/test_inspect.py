"""Run locally: python3 -I scripts/vps-access/test_inspect.py (no Docker needed)."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('inventory', Path(__file__).with_name('inspect.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)
ID = 'a' * 64
SECRET = 'SENTINEL_PASSWORD_CLIENT_SECRET_JWK'


class InventoryTests(unittest.TestCase):
    def test_declared_allowlist(self):
        data = {'authentication_backend': {'file': {'path': SECRET}},
                'access_control': {'default_policy': '${UNSAFE_' + SECRET + '}'},
                'notifier': {'smtp': {'host': SECRET, 'username': SECRET, 'password': SECRET}},
                'identity_providers': {'oidc': {'hmac_secret': SECRET, 'jwks': [SECRET],
                    'clients': [{'client_id': SECRET, 'client_secret': SECRET,
                                 'authorization_policy': 'two_factor'},
                                {'authorization_policy': SECRET}]}},
                'session': {'cookies': [{'domain': 'auth.example.org'},
                                        {'domain': '${' + SECRET + '}'}, {'domain': '-bad.org'}]}}
        result = inventory.declarations(data)
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(result['default_policy'], 'unknown')
        self.assertEqual(result['oidc_policy_counts']['two_factor'], 1)
        self.assertEqual(result['oidc_policy_counts']['unknown'], 1)
        self.assertEqual(result['cookie_domains'], ['auth.example.org'])

    def test_file_bounds_symlinks_and_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            # Resolve macOS /var -> /private/var before testing symlink rejection.
            directory = os.path.realpath(directory)
            path = Path(directory, 'configuration.yml')
            path.write_text(SECRET)
            seen = []
            def loader(raw):
                seen.append(raw)
                return {'password': SECRET}
            self.assertEqual(inventory.candidate(directory, path.name, loader)['status'], 'declared_only')
            self.assertEqual(len(seen), 1)
            self.assertEqual(inventory.candidate(directory, path.name, None)['status'], 'unknown_no_parser')
            with patch.object(inventory.os, 'open', side_effect=PermissionError(SECRET)):
                self.assertNotIn(SECRET, json.dumps(inventory.candidate(directory, path.name, loader)))
            path.write_bytes(b'x' * 131073)
            self.assertEqual(inventory.candidate(directory, path.name, loader)['status'], 'unknown_unsafe_file')
            path.unlink()
            path.symlink_to('/does/not/exist')
            self.assertTrue(inventory.candidate(directory, path.name, loader)['status'].startswith('unknown'))
            self.assertEqual(len(seen), 1)

    def test_parser_exception_is_private(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = os.path.realpath(directory)
            Path(directory, 'configuration.yml').write_text('password: ' + SECRET)
            def broken(raw):
                raise ValueError(SECRET)
            result = inventory.candidate(directory, 'configuration.yml', broken)
            self.assertEqual(result, {'status': 'unknown_unavailable_or_invalid'})

    def test_fake_runner_collision_and_no_mutations(self):
        commands = []
        meta = {'id': ID, 'image': 'example/not-authelia', 'config_digest': 'sha256:' + ID,
                'user': '', 'readonly_rootfs': False, 'cap_add': None, 'cap_drop': None,
                'security_options': None, 'port_bindings': {},
                'mounts': [{'type': 'bind', 'source': '/never/read', 'destination': '/config', 'read_only': True}]}
        def runner(args):
            commands.append(args)
            if 'ps' in args:
                return '\t'.join(map(json.dumps, [ID, 'collision', 'example/not-authelia', '0.0.0.0:9091->80/tcp']))
            if 'inspect' in args:
                return json.dumps(meta)
            if 'list-units' in args:
                return 'authelia.service loaded active running\n--unsafe-' + SECRET
            return 'Id=authelia.service\nUser=authelia\nActiveState=active\nMainPID=1\nFragmentPath=/etc/systemd/system/authelia.service'
        with patch.object(inventory, 'candidate', side_effect=AssertionError('must not read')):
            report = inventory.inventory(runner)
        self.assertEqual(report['containers'][0]['classification'], 'port_9091_candidate_not_proven')
        self.assertEqual(report['native_status'], 'partial_unknown')
        self.assertNotIn(SECRET, json.dumps(report))
        for args in commands:
            if args[0] == '/usr/bin/docker':
                self.assertEqual(args[:3], inventory.DOCKER)
                self.assertIn(args[3], ('ps', 'inspect'))
                self.assertNotIn('Config.Env', ' '.join(args))
                self.assertNotIn('Cmd', ' '.join(args))
            else:
                self.assertEqual(args[0], '/usr/bin/systemctl')
                self.assertIn(args[1], ('list-units', 'show'))
                self.assertNotIn('ExecStart', ' '.join(args))

    def test_official_pinned_image_projection(self):
        image = 'authelia/authelia:4.39.28@sha256:' + ID
        meta = {'id': ID, 'image': image, 'config_digest': 'sha256:' + ID,
                'user': '1000', 'readonly_rootfs': True, 'cap_add': None, 'cap_drop': ['ALL'],
                'security_options': ['no-new-privileges'], 'port_bindings': {},
                'mounts': [{'type': 'bind', 'source': '/fixture', 'destination': '/config', 'read_only': True}]}
        def runner(args):
            if 'ps' in args:
                return '\t'.join(map(json.dumps, [ID, 'idp', image, '']))
            if 'inspect' in args:
                return json.dumps(meta)
            return ''
        with patch.object(inventory, 'candidate', return_value={'status': 'unknown_no_parser'}) as read:
            report = inventory.inventory(runner)
        self.assertEqual(report['containers'][0]['classification'], 'authelia_image')
        self.assertEqual(read.call_count, 2)
        self.assertFalse(report['oidc_proven'])
        self.assertFalse(report['mfa_proven'])

    def test_missing_metadata_is_unknown(self):
        def runner(args):
            if 'ps' in args:
                return '\t'.join(map(json.dumps, [ID, 'authelia', 'authelia/authelia:4', '']))
            return None
        report = inventory.inventory(runner)
        self.assertEqual(report['containers'][0]['metadata'], 'unknown')
        self.assertEqual(report['native_status'], 'unknown')
        self.assertFalse(report['mfa_proven'])
        self.assertFalse(report['oidc_proven'])

    def test_gate_and_subprocess_constraints(self):
        with patch.object(inventory.sys, 'platform', 'darwin'), patch('builtins.print'), \
                patch.object(inventory, 'inventory') as scan:
            self.assertEqual(inventory.main(), 1)
            scan.assert_not_called()
        with patch.object(inventory.subprocess, 'run', side_effect=OSError(SECRET)) as process:
            self.assertIsNone(inventory.run(['/usr/bin/systemctl', 'list-units']))
            kwargs = process.call_args.kwargs
            self.assertEqual(kwargs['env'], inventory.ENV)
            self.assertEqual(kwargs['timeout'], 15)
            self.assertEqual(kwargs['stderr'], inventory.subprocess.DEVNULL)
            self.assertNotIn('shell', kwargs)


if __name__ == '__main__':
    unittest.main()
