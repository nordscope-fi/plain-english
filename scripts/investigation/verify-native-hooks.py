import argparse
import hashlib
import json
import os
import pathlib
import shlex
import signal
import subprocess
import tempfile
import time

import tomllib

PARSER = argparse.ArgumentParser(
    description="Measure generated native hooks in disposable repositories. Requires Python3.11 or newer."
)
PARSER.add_argument(
    "--agent",
    required=True,
    choices=["codex", "cursor", "copilot", "vibe", "qwen", "antigravity"],
)
PARSER.add_argument("--repeat-codex-chat", action="store_true")
PARSER.add_argument("--case", choices=["bad", "clean", "excluded", "advisory"])
PARSER.add_argument(
    "--repo", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[2]
)
PARSER.add_argument("--output", type=pathlib.Path, required=True)
PARSER.add_argument("--keep-private-output", action="store_true")
PARSER.add_argument("--qwen-managed-version")
PARSER.add_argument("--qwen-bootstrap")
ARGS = PARSER.parse_args()
BASE = pathlib.Path(tempfile.mkdtemp(prefix="plain-english-native-")).resolve()
REPO = ARGS.repo.resolve()
TRACE = pathlib.Path(__file__).with_name("native-hook-trace.py")
CURSOR_ISOLATE = pathlib.Path(__file__).with_name("cursor-isolate.cjs")


def toml_value(value):
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(toml_value(v) for v in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(json.dumps(k) + " = " + toml_value(v) for k, v in value.items())
            + "}"
        )
    raise TypeError(type(value).__name__)


def toml_tables(name, rows):
    return "".join(
        f"[[{name}]]\n"
        + "".join(f"{k} = {toml_value(v)}\n" for k, v in row.items())
        + "\n"
        for row in rows
    )


def check_declarations(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key.lower() in [
                "api_key",
                "apikey",
                "access_token",
                "refresh_token",
                "password",
                "secret",
            ]:
                raise ValueError(
                    "Inline credentials are not supported; use environment key references."
                )
            check_declarations(item)
    elif isinstance(value, list):
        for item in value:
            check_declarations(item)


def configuration_environment(agent):
    env = {}
    if agent == "vibe":
        from dotenv import dotenv_values

        original = pathlib.Path.home() / ".vibe"
        configuration = tomllib.loads((original / "config.toml").read_text())
        check_declarations(configuration["providers"])
        check_declarations(configuration["models"])
        local = BASE / "vibe-home"
        local.mkdir(exist_ok=True)
        (local / "config.toml").write_text(
            "active_model = "
            + toml_value(configuration["active_model"])
            + "\n"
            + toml_tables("providers", configuration["providers"])
            + toml_tables("models", configuration["models"])
        )
        env.update({k: v for k, v in dotenv_values(original / ".env").items() if v})
        env["VIBE_HOME"] = str(local)
    if agent == "qwen":
        configuration = json.loads(
            (pathlib.Path.home() / ".qwen/settings.json").read_text()
        )
        if configuration["security"]["auth"]["selectedType"] != "openai":
            raise ValueError(
                "This Qwen fixture requires an environment-backed OpenAI-compatible provider."
            )
        check_declarations(configuration.get("modelProviders", {}))
        check_declarations(configuration.get("model", {}))
        local = BASE / "qwen-home"
        local.mkdir(exist_ok=True)
        (local / "settings.json").write_text(
            json.dumps(
                {
                    "security": {
                        "auth": {
                            "selectedType": configuration["security"]["auth"][
                                "selectedType"
                            ]
                        }
                    },
                    "modelProviders": configuration.get("modelProviders", {}),
                    "model": configuration.get("model", {}),
                },
                indent=2,
            )
            + "\n"
        )
        env.update(configuration.get("env", {}))
        env["QWEN_HOME"] = str(local)
        if ARGS.qwen_managed_version:
            if not ARGS.qwen_bootstrap:
                raise ValueError(
                    "--qwen-bootstrap is required with --qwen-managed-version"
                )
            update_root = str(pathlib.Path.home() / ".qwen/updates/npm")
            env.update(
                QWEN_CODE_MANAGED_NPM_ROOT=update_root,
                QWEN_CODE_MANAGED_NPM_PIN=json.dumps(
                    {
                        "bootstrap": ARGS.qwen_bootstrap,
                        "version": ARGS.qwen_managed_version,
                        "updateRoot": update_root,
                    }
                ),
            )
    return env


def setup(agent, case):
    root = BASE / f"{agent}-{case}"
    root.mkdir()
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    (root / "node_modules").mkdir(exist_ok=True)
    link = root / "node_modules/plain-english"
    if not link.exists():
        link.symlink_to(REPO, target_is_directory=True)
    subprocess.run(
        ["node", str(REPO / "dist/cli.js"), "init", "--agent", agent],
        cwd=root,
        capture_output=True,
        check=True,
    )
    (root / "AGENTS.md").unlink(missing_ok=True)
    threshold = "never" if case == "advisory" else "error"
    (root / ".plain-english.yml").write_text(
        f"version: 1\nextends: default\nmodelChecks: false\nfailOn: {threshold}\nexclude: [excluded.md]\nchat:\n  failOn: {threshold}\n"
    )
    for name in ["write.md", "excluded.md"]:
        path = root / name
        if agent in ["vibe", "qwen"]:
            path.unlink(missing_ok=True)
        else:
            path.write_text("This is the original sentence.\n")
    if agent == "vibe":
        path = root / ".vibe/hooks.toml"
        rows = tomllib.loads(path.read_text())["hooks"]
        for row in rows:
            row["command"] = (
                f"python3 {shlex.quote(str(TRACE))} {row['type']} "
                + shlex.quote(row["command"])
            )
        rows += [
            {
                "name": f"audit-{event}",
                "type": event,
                "command": f"python3 {shlex.quote(str(TRACE))} {event}",
            }
            for event in ["pre_tool", "post_tool", "post_agent"]
        ]
        path.write_text(toml_tables("hooks", rows))
    else:
        path = (
            root
            / {
                "qwen": ".qwen/settings.json",
                "copilot": ".github/hooks/plain-english.json",
                "codex": ".codex/hooks.json",
                "antigravity": ".agents/hooks.json",
                "cursor": ".cursor/hooks.json",
            }[agent]
        )
        config = json.loads(path.read_text())
        event_maps = (
            list(config.values()) if agent == "antigravity" else [config["hooks"]]
        )
        for event, groups in [
            (event, groups) for events in event_maps for event, groups in events.items()
        ]:
            for group in groups:
                for hook in group.get("hooks", [group]):
                    for key in ["command", "bash", "powershell"]:
                        if key in hook:
                            hook[key] = (
                                f"python3 {shlex.quote(str(TRACE))} {event} "
                                + shlex.quote(hook[key])
                            )
            tracer = {
                "type": "command",
                "command": f"python3 {shlex.quote(str(TRACE))} {event}",
            }
            if agent == "cursor":
                groups.append({"command": tracer["command"]})
            elif agent == "antigravity" and event == "Stop":
                groups.append(tracer)
            elif agent in ["qwen", "codex", "antigravity"]:
                groups.append({"matcher": ".*", "hooks": [tracer]})
            else:
                groups.append(
                    {
                        "type": "command",
                        "bash": tracer["command"],
                        "powershell": tracer["command"],
                    }
                )
        path.write_text(json.dumps(config, indent=2) + "\n")
    return root


def run(agent, case):
    root = setup(agent, case)
    file = "excluded.md" if case == "excluded" else "write.md"
    required = (
        "This is a clear sentence." if case == "clean" else "We leverage this approach."
    )
    prompt = f'Authorized synthetic hook test in a disposable directory. Use only your native file-writing tool once to replace {root / file} with exactly "{required}" and a newline. Do not use shell, read other files, delegate or edit any other file. Preserve the requested sentence. If a hook refuses, report the refusal and stop immediately. Reply briefly without banned terms.'
    env = {
        **os.environ,
        **configuration_environment(agent),
        "PLAIN_ENGLISH_CHAT_JUDGE": "1",
        "PE_NATIVE_FIXTURE": str(root),
        "GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS": "true",
    }
    if agent == "vibe":
        cmd = [
            "vibe",
            "--trust",
            "--auto-approve",
            "--max-turns",
            "3",
            "--max-price",
            "0.5",
            "--enabled-tools",
            "write_file",
            "--output",
            "json",
            "-p",
            prompt,
        ]
    elif agent == "qwen":
        cmd = [
            "qwen",
            "--approval-mode",
            "auto-edit",
            "--advisor",
            "off",
            "--max-session-turns",
            "3",
            "--max-wall-time",
            "45s",
            "--max-tool-calls",
            "1",
            "--output-format",
            "stream-json",
            "-p",
            prompt,
        ]
    elif agent == "cursor":
        env["NODE_OPTIONS"] = "--require " + json.dumps(str(CURSOR_ISOLATE))
        env["NODE_COMPILE_CACHE"] = str(BASE / "cursor-compile-cache")
        prompt = f'Use StrReplace exactly once on {root / file}: old_string="This is the original sentence.", new_string="{required}". This is an authorized synthetic hook test in a disposable directory. Do not use shell, read files, delegate, or change any other file. Preserve the requested replacement. If a hook refuses, report the refusal and stop. Reply briefly.'
        cmd = [
            "agent",
            "--print",
            "--force",
            "--trust",
            "--output-format",
            "stream-json",
            prompt,
        ]
    elif agent == "antigravity":
        env.pop("GEMINI_API_KEY", None)
        env.pop("GOOGLE_API_KEY", None)
        prompt = f'Use replace_file_content exactly once on TargetFile={root / file}. The file contains exactly "This is the original sentence." and a newline. StartLine=1, EndLine=1, TargetContent="This is the original sentence.", ReplacementContent="{required}". This is an authorized synthetic hook test in a disposable directory. Do not read files, use shell, delegate, or change the required replacement. If refused, report refusal and stop.'
        cmd = [
            "agy",
            "-p",
            prompt,
            "--output-format",
            "json",
            "--print-timeout",
            "80s",
            "--dangerously-skip-permissions",
        ]
    elif agent == "codex":
        (root / ".codex/config.toml").write_text("[features]\nhooks = true\n")
        for key in [
            "CODEX_CI",
            "CODEX_SANDBOX",
            "CODEX_SANDBOX_NETWORK_DISABLED",
            "CODEX_PERMISSION_PROFILE",
            "CODEX_SESSION_ID",
            "CODEX_THREAD_ID",
        ]:
            env.pop(key, None)
        cmd = [
            "codex",
            "--no-daemon",
            "-a",
            "never",
            "exec",
            "--ignore-user-config",
            "--enable",
            "hooks",
            "-c",
            "hooks="
            + toml_value(json.loads((root / ".codex/hooks.json").read_text())["hooks"]),
            "--sandbox",
            "workspace-write",
            "--dangerously-bypass-hook-trust",
            "--skip-git-repo-check",
            "-c",
            f'projects."{root}".trust_level="trusted"',
            "-c",
            "project_doc_max_bytes=0",
            "--json",
            prompt,
        ]
        cmd[cmd.index(prompt)] = (
            "Use apply_patch exactly once with this exact patch:\n*** Begin Patch\n*** Update File: "
            + str(root / file)
            + "\n@@\n-This is the original sentence.\n+"
            + required
            + "\n*** End Patch\nThis is an authorized synthetic hook test in a disposable directory. Do not use shell, read other files, delegate, or change any other file. Preserve the patch. If a hook refuses, report the refusal and stop immediately. Reply briefly."
        )
    else:
        cmd = [
            "copilot",
            "--no-auto-update",
            "--no-custom-instructions",
            "--disable-builtin-mcps",
            "--no-ask-user",
            "--allow-all-tools",
            "--model",
            "auto",
            "--output-format",
            "json",
            "-p",
            prompt,
        ]
    started = time.monotonic()
    process = subprocess.Popen(
        cmd,
        cwd=root,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    timeout = False
    try:
        out, err = process.communicate(timeout=90)
    except subprocess.TimeoutExpired:
        timeout = True
        os.killpg(process.pid, signal.SIGTERM)
        try:
            out, err = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            out, err = process.communicate()
    content = (root / file).read_text() if (root / file).exists() else None
    records = [
        json.loads(p.read_text())
        for p in sorted((root / "event-metadata").glob("*.json"))
    ]
    result = {
        "agent": agent,
        "case": case,
        "exit_code": process.returncode,
        "timed_out": timeout,
        "duration_seconds": round(time.monotonic() - started, 2),
        "file_written_exactly": content == required + "\n",
        "file_unchanged": content == "This is the original sentence.\n",
        "file_absent": content is None,
        "events": records,
        "stdout_hash": hashlib.sha256(out.encode()).hexdigest(),
        "stderr_hash": hashlib.sha256(err.encode()).hexdigest(),
    }
    result["control_observed"] = bool(
        any("exit_code" in e for e in records)
        and (
            any(
                e.get("decision") == "deny"
                and e["event"] in ["PreToolUse", "preToolUse", "pre_tool"]
                for e in records
            )
            and not result["file_written_exactly"]
            if case == "bad"
            else result["file_written_exactly"]
        )
    )
    # Raw responses stay private and are never part of the published evidence.
    if ARGS.keep_private_output:
        private = root / "private-output"
        private.mkdir(mode=0o700, exist_ok=True)
        (private / "stdout.txt").write_text(out)
        (private / "stderr.txt").write_text(err)
    (root / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k != "events"}), flush=True)
    return result


def repeated_codex_chat():
    root = setup("codex", "chat")
    env = {
        **os.environ,
        "PLAIN_ENGLISH_CHAT_JUDGE": "1",
        "PE_NATIVE_FIXTURE": str(root),
    }
    for key in [
        "CODEX_CI",
        "CODEX_SANDBOX",
        "CODEX_SANDBOX_NETWORK_DISABLED",
        "CODEX_PERMISSION_PROFILE",
        "CODEX_SESSION_ID",
        "CODEX_THREAD_ID",
    ]:
        env.pop(key, None)
    hooks = "hooks=" + toml_value(
        json.loads((root / ".codex/hooks.json").read_text())["hooks"]
    )
    prefix = [
        "codex",
        "--no-daemon",
        "-a",
        "never",
        "exec",
        "--ignore-user-config",
        "--enable",
        "hooks",
        "-c",
        hooks,
        "--dangerously-bypass-hook-trust",
        "--json",
    ]
    session = None
    results = []
    for turn in [1, 2]:
        before = set((root / "event-metadata").glob("*.json"))
        prompt = (
            "Do not use tools. Reply exactly: The result is ready "
            + chr(0x2014)
            + " check it. If a hook requests a rewrite, replace the punctuation with a full stop."
        )
        cmd = (
            prefix
            + (["resume", session] if session else ["--skip-git-repo-check"])
            + [prompt]
        )
        start = time.monotonic()
        process = subprocess.Popen(
            cmd,
            cwd=root,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        timed_out = False
        try:
            out, err = process.communicate(timeout=90)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                out, err = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                out, err = process.communicate()
        if session is None:
            for line in out.splitlines():
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("type") == "thread.started":
                    session = row["thread_id"]
        events = [
            json.loads(p.read_text())
            for p in sorted(set((root / "event-metadata").glob("*.json")) - before)
        ]
        result = {
            "explicit_user_turn": turn,
            "exit_code": process.returncode,
            "timed_out": timed_out,
            "duration_seconds": round(time.monotonic() - start, 2),
            "events": events,
            "stdout_hash": hashlib.sha256(out.encode()).hexdigest(),
            "stderr_hash": hashlib.sha256(err.encode()).hexdigest(),
        }
        stops = [e for e in events if e["event"] == "Stop" and e.get("exit_code") == 0]
        result["control_observed"] = bool(
            any(e.get("rewrite_requested") for e in stops)
            and stops
            and stops[-1].get("reply_keys") == []
        )
        results.append(result)
        if not session or timed_out:
            break
    return results


if __name__ == "__main__":
    if ARGS.repeat_codex_chat and ARGS.agent != "codex":
        PARSER.error("--repeat-codex-chat requires --agent codex")
    results = [
        run(ARGS.agent, case)
        for case in (
            [ARGS.case] if ARGS.case else ["bad", "clean", "excluded", "advisory"]
        )
    ]
    report = {"schema": 1, "agent": ARGS.agent, "observations": results}
    if ARGS.repeat_codex_chat:
        report["repeated_user_turns"] = repeated_codex_chat()
    ARGS.output.write_text(json.dumps(report, indent=2) + "\n")
    print("Fixture directory: " + str(BASE))
    if not all(row["control_observed"] for row in results):
        raise SystemExit(2)
    if ARGS.repeat_codex_chat and (
        len(report["repeated_user_turns"]) != 2
        or not all(row["control_observed"] for row in report["repeated_user_turns"])
    ):
        raise SystemExit(2)
