#!/usr/bin/env python3
"""Drive the one known form in the upstream SEP-1034 conformance scenario."""

import os
import pty
import re
import select
import subprocess
import sys
import time
import json

TOOL = "test_client_elicitation_defaults"
MESSAGE = "Test client default value handling - please accept with defaults"
FIELDS = {
    "name": {
        "type": "string",
        "description": "User name",
        "default": "John Doe",
    },
    "age": {
        "type": "integer",
        "description": "User age",
        "default": 30,
    },
    "score": {
        "type": "number",
        "description": "User score",
        "default": 95.5,
    },
    "status": {
        "type": "string",
        "enum": ["active", "inactive", "pending"],
        "description": "User status",
        "default": "active",
    },
    "verified": {
        "type": "boolean",
        "description": "Verification status",
        "default": True,
    },
}
EXPECTED_SCHEMA = {"type": "object", "properties": FIELDS, "required": []}
CHOICES_PROMPT = b"Choose accept, decline, or cancel: "
CONTENT_PROMPT = b"Enter a JSON object: "
CONTENT = b'{"name":"John Doe","age":30,"score":95.5,"status":"active","verified":true}\n'


def validate_form_prompt(terminal_output):
    text = terminal_output.decode(errors="replace")
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text).replace("\r\n", "\n")
    start = text.find("Server requests input:\n")
    schema_start = text.find("\nSchema:\n", start)
    choices_start = text.find("\nChoose accept, decline, or cancel: ", schema_start)
    if start < 0 or schema_start < 0 or choices_start < 0:
        raise RuntimeError("Could not parse the conformance elicitation prompt")

    message = json.loads(text[start + len("Server requests input:\n") : schema_start])
    schema = json.loads(text[schema_start + len("\nSchema:\n") : choices_start])
    if message != MESSAGE or not same_json_value(schema, EXPECTED_SCHEMA):
        raise RuntimeError("Unexpected elicitation prompt or schema; refusing acceptance")


def same_json_value(actual, expected):
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(
            same_json_value(actual[key], expected[key]) for key in expected
        )
    if isinstance(expected, list):
        return len(actual) == len(expected) and all(
            same_json_value(actual_item, expected_item)
            for actual_item, expected_item in zip(actual, expected)
        )
    return actual == expected


def main():
    if len(sys.argv) < 3:
        raise RuntimeError("Expected mcpc executable and arguments")

    executable, *args = sys.argv[1:]
    if len(args) < 4 or args[1:3] != ["tools-call", TOOL] or "--elicitation" not in args:
        raise RuntimeError("Refusing to drive an unexpected mcpc command")

    master, slave = pty.openpty()
    process = subprocess.Popen(args=[executable, *args], stdin=slave, stdout=subprocess.PIPE, stderr=slave)
    os.close(slave)
    terminal_output = bytearray()
    sent_accept = False
    sent_content = False
    deadline = time.monotonic() + 45

    try:
        while process.poll() is None and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if not ready:
                continue
            try:
                data = os.read(master, 4096)
            except OSError:
                break
            terminal_output.extend(data)

            if not sent_accept and CHOICES_PROMPT in terminal_output:
                validate_form_prompt(terminal_output)
                os.write(master, b"accept\n")
                sent_accept = True
            elif sent_accept and not sent_content and CONTENT_PROMPT in terminal_output:
                os.write(master, CONTENT)
                sent_content = True

        if process.poll() is None:
            raise RuntimeError("Timed out waiting for conformance elicitation result")
        stdout, _ = process.communicate(timeout=5)
        if not sent_accept or not sent_content:
            raise RuntimeError("Conformance elicitation prompt did not complete")
        sys.stdout.buffer.write(stdout)
        sys.stderr.buffer.write(terminal_output)
        return process.returncode
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"[mcpc-conformance] {error}", file=sys.stderr)
        sys.exit(1)
