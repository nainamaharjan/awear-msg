#!/usr/bin/env python3
"""Conformance runner — the language-agnostic judge.

Boots a fresh server, replays a scenario YAML against a client (driven through its
control interface, control-interface.md), and asserts the client's JSON output
matches each step's `expect` block. The same runner grades any client in any
language, because it only relies on the control interface, not on the client's
internals.

Usage:
  python conformance/run.py --client "python -m client" --client-dir clients/python \\
      --scenario spec/conformance/scenario_01.yaml

  python conformance/run.py --client "node dist/cli.js" --client-dir clients/typescript \\
      --scenario spec/conformance/scenario_01.yaml

Requires PyYAML for the test harness only (the clients and server stay dependency
free):  pip install pyyaml
"""

import argparse
import json
import shlex
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("conformance runner needs PyYAML: pip install pyyaml")

REPO_ROOT = Path(__file__).resolve().parents[1]
SERVER = REPO_ROOT / "server" / "app.py"


# --- assertion: subset match (only the keys in `expected` are checked) --------
def matches(expected, actual, path="$"):
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False, f"{path}: expected object, got {type(actual).__name__}"
        for k, v in expected.items():
            if k not in actual:
                return False, f"{path}.{k}: missing in output"
            ok, msg = matches(v, actual[k], f"{path}.{k}")
            if not ok:
                return False, msg
        return True, ""
    if isinstance(expected, list):
        if not isinstance(actual, list):
            return False, f"{path}: expected list, got {type(actual).__name__}"
        if len(expected) != len(actual):
            return False, f"{path}: expected {len(expected)} item(s), got {len(actual)}"
        for i, (e, a) in enumerate(zip(expected, actual)):
            ok, msg = matches(e, a, f"{path}[{i}]")
            if not ok:
                return False, msg
        return True, ""
    if expected != actual:
        return False, f"{path}: expected {expected!r}, got {actual!r}"
    return True, ""


# --- server lifecycle ---------------------------------------------------------
def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for_server(url, timeout=8.0):
    deadline = time.time() + timeout
    probe = f"{url}/messages?user=__probe__&after=0"
    while time.time() < deadline:
        try:
            req = urllib.request.Request(probe, headers={"X-Protocol-Version": "1"})
            urllib.request.urlopen(req, timeout=1)
            return True
        except urllib.error.HTTPError:
            return True          # server responded at all -> it's up
        except Exception:
            time.sleep(0.15)
    return False


def boot_server(python_exe):
    port = free_port()
    url = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(
        [python_exe, str(SERVER), "--port", str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if not wait_for_server(url):
        proc.terminate()
        sys.exit(f"server did not become ready on {url}")
    return proc, url


# --- client invocation --------------------------------------------------------
def arg_to_str(a):
    if isinstance(a, bool):
        return "true" if a else "false"
    return str(a)


def run_client(launch, client_dir, server_url, store, command, args):
    cmd = (shlex.split(launch)
           + ["--server", server_url, "--store", store, command]
           + [arg_to_str(a) for a in args])
    res = subprocess.run(cmd, cwd=client_dir, capture_output=True,
                         text=True, timeout=30)
    lines = [ln for ln in res.stdout.splitlines() if ln.strip()]
    if not lines:
        return None, res, "client produced no stdout"
    try:
        return json.loads(lines[-1]), res, None
    except json.JSONDecodeError as e:
        return None, res, f"final stdout line is not JSON: {e}"


# --- main ---------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Replay a conformance scenario against a client.")
    ap.add_argument("--client", required=True, help='launch command, e.g. "python -m client"')
    ap.add_argument("--client-dir", default=".", help="directory to run the client from")
    ap.add_argument("--scenario", required=True, help="path to a scenario YAML")
    ap.add_argument("--server", default=None, help="use an existing server URL instead of booting one")
    ap.add_argument("--python", default=sys.executable, help="python used to boot the server")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    scenario = yaml.safe_load(Path(args.scenario).read_text())
    actors = list((scenario.get("clients") or {}).keys()) or \
        sorted({s["actor"] for s in scenario["steps"]})

    client_dir = str((REPO_ROOT / args.client_dir).resolve()
                     if not Path(args.client_dir).is_absolute() else args.client_dir)

    server_proc = None
    tmp = Path(tempfile.mkdtemp(prefix="conformance-"))
    stores = {a: str(tmp / f"{a}.json") for a in actors}

    try:
        if args.server:
            server_url = args.server
        else:
            server_proc, server_url = boot_server(args.python)

        print(f"scenario: {scenario.get('name', args.scenario)}")
        print(f"client:   {args.client}  (cwd: {client_dir})")
        print(f"server:   {server_url}\n")

        passed = failed = 0
        for i, step in enumerate(scenario["steps"], 1):
            actor = step["actor"]
            command = step["cmd"]
            cargs = step.get("args", [])
            expect = step.get("expect", {})

            actual, res, err = run_client(args.client, client_dir, server_url,
                                          stores[actor], command, cargs)
            label = f"[{i:02d}] {actor} {command} {' '.join(arg_to_str(a) for a in cargs)}".rstrip()

            if err:
                failed += 1
                print(f"FAIL {label}\n     {err}\n     stderr: {res.stderr.strip()[:300]}")
                continue

            ok, msg = matches(expect, actual)
            if ok:
                passed += 1
                print(f"PASS {label}")
                if args.verbose:
                    print(f"     -> {json.dumps(actual)}")
            else:
                failed += 1
                print(f"FAIL {label}\n     {msg}\n     output: {json.dumps(actual)}")

        print(f"\n{passed}/{passed + failed} steps passed")
        return 0 if failed == 0 else 1

    finally:
        if server_proc:
            server_proc.terminate()
            try:
                server_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                server_proc.kill()


if __name__ == "__main__":
    sys.exit(main())