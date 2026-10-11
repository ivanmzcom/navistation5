#!/usr/bin/env python3
"""Build one automatic-discovery ELF; never connect to or modify a console."""
import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hermesc', type=Path, default=os.environ.get('HERMESC'),
                        help='Hermes 0.12.0 compiler (HBC v89), or set HERMESC')
    parser.add_argument('--config', type=Path, default=ROOT / 'config.local.json')
    args = parser.parse_args()
    if not args.hermesc:
        parser.error('set HERMESC or pass --hermesc')
    if not os.environ.get('PS5_PAYLOAD_SDK'):
        parser.error('set PS5_PAYLOAD_SDK to your SDK checkout')
    if not args.config.is_file():
        parser.error('copy config.example.json to config.local.json and configure your server')
    if not (ROOT / 'node_modules/.bin/esbuild').is_file():
        parser.error('run npm ci first')
    out = ROOT / 'build'
    out.mkdir(exist_ok=True)
    token = out / 'control.token'
    if not token.exists():
        fd = os.open(token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(secrets.token_hex(32) + '\n')
    token.chmod(0o600)
    commands = [
        ['python3', 'tools/build_ui.py', '--esbuild', str(ROOT / 'node_modules/.bin/esbuild'),
         '--hermesc', str(args.hermesc.resolve()), '--babel-root', str(ROOT / 'node_modules'),
         '--config', str(args.config.resolve()), '--minify-identifiers'],
        ['make', '-C', 'tools', '-f', 'cc_bootstrap_stub.mk'],
        ['python3', 'tools/build_cc_package.py', '--auto-detect', '--package-id', 'navistation5-v0_1_0',
         '--reviewed-barrier', '--audio-token-file', str(token)],
        ['make', '-C', 'tools', '-f', 'cc_installer.mk', 'INSTALLER_ENABLE_PUBLICATION=1'],
    ]
    for command in commands:
        subprocess.run(command, cwd=ROOT, check=True)
    target = out / 'navistation5.elf'
    shutil.copyfile(out / 'navidrome-cc-installer-enabled.elf', target)
    target.chmod(0o600)
    print('Built ' + str(target))


if __name__ == '__main__':
    main()
