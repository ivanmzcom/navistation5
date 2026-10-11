#!/usr/bin/env python3
"""Bundle local UI source and compile Hermes v89; never execute or deploy it."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess
from urllib.parse import urlsplit


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        help="Private JSON with serverUrl; never include credentials",
    )
    parser.add_argument("--esbuild", required=True, type=Path)
    parser.add_argument("--hermesc", required=True, type=Path)
    parser.add_argument(
        "--babel-root",
        required=True,
        type=Path,
        help="node_modules containing @babel/core, plugin-transform-classes, plugin-transform-for-of and plugin-transform-block-scoping",
    )
    parser.add_argument(
        "--entry",
        type=Path,
        default=Path("ui/direct-music-entry.mjs"),
        help="Production entry module within this project's ui directory",
    )
    parser.add_argument(
        "--minify-identifiers",
        action="store_true",
        help="Shorten private JS identifiers to fit the original HBC allocation budget",
    )
    args = parser.parse_args()
    server_url = "http://navidrome.local:4533"
    if args.config:
        config = json.loads(args.config.read_text())
        if set(config) != {"serverUrl"}:
            parser.error(
                "config must contain only serverUrl; enter credentials on the console"
            )
        server_url = config["serverUrl"]
    if not isinstance(server_url, str) or any(
        ord(c) < 33 or ord(c) > 126 for c in server_url
    ):
        parser.error("serverUrl must be an ASCII HTTP(S) origin")
    url = urlsplit(server_url)
    if (
        url.scheme not in ("http", "https")
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
        or url.path not in ("", "/")
        or "\\" in server_url
    ):
        parser.error(
            "serverUrl must be an HTTP(S) origin without credentials, path, query or fragment"
        )
    try:
        url.port
    except ValueError:
        parser.error("serverUrl has an invalid port")
    server_url = server_url.rstrip("/")
    root = Path(__file__).resolve().parent.parent
    entry = (root / args.entry).resolve(strict=True)
    entry.relative_to(root / "ui")
    out = root / "build"
    out.mkdir(exist_ok=True)
    tools = {}
    for name, path, flag in [
        ("esbuild", args.esbuild, "--version"),
        ("hermesc", args.hermesc, "-version"),
    ]:
        path = path.resolve(strict=True)
        version = subprocess.check_output(
            [str(path), flag], text=True, stderr=subprocess.STDOUT
        )
        tools[name] = {
            "path": str(path),
            "sha256": sha(path),
            "version": version.strip(),
        }
    if "HBC bytecode version: 89" not in [
        line.strip() for line in tools["hermesc"]["version"].splitlines()
    ]:
        raise SystemExit(
            "This firmware profile requires a Hermes bytecode v89 compiler"
        )
    script = out / "navidrome-bootstrap.js"
    bundled = out / "navidrome-bootstrap.bundle.js"
    bytecode = out / "navidrome-bootstrap.hbc"
    metadata = out / "navidrome-bootstrap.esbuild.json"
    subprocess.run(
        [
            tools["esbuild"]["path"],
            str(entry),
            "--bundle",
            "--platform=neutral",
            "--format=iife",
            "--global-name=NavidromePS5",
            "--define:__NAVISTATION_SERVER_URL__=" + json.dumps(server_url),
            "--target=es2015",
            "--charset=ascii",
            "--tree-shaking=true",
            "--outfile=" + str(bundled),
            "--metafile=" + str(metadata),
        ]
        + (["--minify-identifiers"] if args.minify_identifiers else []),
        cwd=root,
        check=True,
    )
    babel_root = args.babel_root.resolve(strict=True)
    tools["babel"] = json.loads(
        subprocess.check_output(
            [
                "node",
                str(root / "tools/lower_ui.cjs"),
                str(babel_root),
                str(bundled),
                str(script),
            ],
            cwd=root,
            text=True,
        )
    )
    tools["babel"]["path"] = str(babel_root)
    if (
        not tools["babel"].get("transformBlockScoping")
        or not tools["babel"].get("transformForOf")
        or tools["babel"].get("loweringPasses")
        != ["for-of", "classes-and-block-scoping"]
        or tools["babel"].get("blockScopingOptions")
        != {"throwIfClosureRequired": False, "tdz": False}
        or tools["babel"].get("lexicalReadPolicy")
        != "source-bindings-must-be-initialized-before-read"
    ):
        raise SystemExit(
            "The Hermes lowering step must preserve loop captures without TDZ counter resets"
        )
    tools["babel"]["loweringScriptSha256"] = sha(root / "tools/lower_ui.cjs")
    subprocess.run(
        [
            tools["hermesc"]["path"],
            "-O",
            "-emit-binary",
            "-out",
            str(bytecode),
            str(script),
        ],
        cwd=root,
        check=True,
    )
    raw = bytecode.read_bytes()
    if len(raw) < 128 or struct.unpack_from("<Q", raw)[0] != 0x1F1903C103BC1FC6:
        raise SystemExit("Compiler output does not have the expected Hermes header")
    version = struct.unpack_from("<I", raw, 8)[0]
    if version != 89 or hashlib.sha1(raw[:-20]).digest() != raw[-20:]:
        raise SystemExit("Compiler output has an unexpected version or footer digest")
    inputs = json.loads(metadata.read_text())["inputs"]
    sources = {}
    for name in inputs:
        path = (root / name).resolve(strict=True)
        path.relative_to(root / "ui")
        sources[name] = sha(path)
    manifest = {
        "schema": 1,
        "entry": str(entry.relative_to(root)),
        "firmwareProfile": "0x13200006",
        "hbcVersion": version,
        "minifyIdentifiers": args.minify_identifiers,
        "globalName": "NavidromePS5",
        "defaultServerUrl": server_url,
        "tools": tools,
        "sources": sources,
        "outputs": {
            p.name: {"bytes": p.stat().st_size, "sha256": sha(p)}
            for p in [script, bytecode]
        },
        "status": "compiled-not-deployed",
    }
    (out / "navidrome-bootstrap.profile.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    print(
        json.dumps(
            {"status": manifest["status"], "outputs": manifest["outputs"]}, indent=2
        )
    )


if __name__ == "__main__":
    main()
