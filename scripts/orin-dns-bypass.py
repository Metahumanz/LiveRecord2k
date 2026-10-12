#!/usr/bin/python3
"""Keep end0's DHCP IPv4 DNS usable alongside WideWired policy routing.

Install with the accompanying systemd/NetworkManager configuration described
in docs/orin-dns-diagnosis-20261008.md. Never flush routing tables or rules.
"""
import fcntl
import ipaddress
import json
import os
import pathlib
import re
import subprocess
import sys

INTERFACE = 'end0'
PRIORITY = 22010
STATE = pathlib.Path('/var/lib/orin-dns-bypass/state.json')


def run(*args):
    return subprocess.check_output(args, text=True, timeout=15).strip()


def addresses(values):
    return sorted({str(ipaddress.IPv4Address(value.removesuffix('/32'))) for value in values})


def nm_values(value):
    # nmcli renders some device arrays on one line separated by " | ".
    return [item.strip() for item in re.split(r'[|\n]', value) if item.strip() and item.strip() != '--']


def main():
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open('/run/orin-dns-bypass.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        previous = addresses(json.loads(STATE.read_text()).get('dns', [])) if STATE.exists() else []
        remove = sys.argv[1:] == ['--remove']
        if not remove and not run('nmcli', '-g', 'GENERAL.STATE', 'device', 'show', INTERFACE).startswith('100'):
            print('end0 is not connected; waiting for NetworkManager dispatcher')
            return
        desired = [] if remove else addresses(nm_values(run('nmcli', '-g', 'IP4.DNS', 'device', 'show', INTERFACE)))
        if not remove and not desired:
            raise RuntimeError('end0 has no IPv4 DNS; refusing to change rules')
        existing = []
        for rule in json.loads(run('ip', '-j', '-4', 'rule', 'show')):
            if rule.get('priority') != PRIORITY:
                continue
            destination = str(rule.get('dst', '')).removesuffix('/32')
            if (destination not in previous + desired or rule.get('table') not in ['main', 254]
                    or rule.get('src', 'all') != 'all'
                    or any(key in rule for key in ['fwmark', 'iif', 'oif', 'ipproto', 'sport', 'dport', 'not'])):
                raise RuntimeError('priority 22010 contains a foreign rule; leaving it untouched')
            existing.append(destination)
        # Establish new routes before retiring old DHCP DNS addresses.
        for address in desired:
            if address not in existing:
                run('ip', '-4', 'rule', 'add', 'priority', str(PRIORITY), 'to', address + '/32', 'lookup', 'main')
        if desired:
            domains = nm_values(run('nmcli', '-g', 'IP4.DOMAIN', 'device', 'show', INTERFACE))
            if '~.' not in domains:
                domains.append('~.')
            run('resolvectl', 'dns', INTERFACE, *desired)
            run('resolvectl', 'domain', INTERFACE, *domains)
        for address in existing:
            if address not in desired:
                run('ip', '-4', 'rule', 'del', 'priority', str(PRIORITY), 'to', address + '/32', 'lookup', 'main')
        temporary = STATE.with_suffix('.tmp')
        temporary.write_text(json.dumps({'interface': INTERFACE, 'priority': PRIORITY, 'dns': desired}) + '\n')
        os.chmod(temporary, 0o600)
        os.replace(temporary, STATE)
        print(json.dumps({'interface': INTERFACE, 'priority': PRIORITY, 'dns': desired}))


if __name__ == '__main__':
    main()
