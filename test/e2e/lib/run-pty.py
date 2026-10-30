#!/usr/bin/env python3
import os
import pty
import select
import subprocess
import sys
import time

prompt = b"Choose accept, decline, or cancel: "
command = sys.argv[1:]
master, slave = pty.openpty()
process = subprocess.Popen(command, stdin=slave, stdout=subprocess.PIPE, stderr=slave)
os.close(slave)
sent = False
terminal_output = bytearray()
deadline = time.monotonic() + 30

while process.poll() is None and time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if not ready:
        continue
    try:
        data = os.read(master, 4096)
    except OSError:
        break
    terminal_output.extend(data)
    if not sent and prompt in terminal_output and os.environ["E2E_ELICITATION_CHOICE"] != "none":
        os.write(master, (os.environ["E2E_ELICITATION_CHOICE"] + "\n").encode())
        if os.environ["E2E_ELICITATION_CHOICE"] == "accept":
            os.write(master, b'{"name":"Ada"}\n')
        sent = True

if process.poll() is None:
    process.kill()
stdout, _ = process.communicate(timeout=5)
os.close(master)
sys.stdout.buffer.write(stdout)
sys.stderr.buffer.write(terminal_output)
if process.returncode is None:
    sys.exit(124)
sys.exit(process.returncode)
