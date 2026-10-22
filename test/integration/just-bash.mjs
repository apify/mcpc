// Run through pnpm after building. Installs the packed CLI in real consumers.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { BINARY, startHttpFixture } from './fixtures/just-bash-server.mjs';

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageInfo = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const pnpm = process.env.npm_execpath;
assert(pnpm?.includes('pnpm'), 'run this test with pnpm run test:just-bash');
const temporary = await mkdtemp(join(tmpdir(), 'mcpc-just-bash-package-'));
const archive = join(temporary, 'mcpc.tgz');
const eventsPath = join(temporary, 'stdio-events.jsonl');
const stdioFixture = join(repo, 'test/integration/fixtures/just-bash-server.mjs');
const label = `@justbash-${process.pid}`;
const secondLabel = `${label}-other`;
const httpLabel = `${label}-http`;
const homes = [];
let installedCli;
let httpFixture;
let checks = 0;

async function check(name, fn) {
  await fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

async function eventually(predicate, message, timeoutMillis = 10_000) {
  const end = Date.now() + timeoutMillis;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

async function events() {
  return (await readFile(eventsPath, 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}

async function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      // Container PID 1 may not reap an exited orphan immediately.
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function cli(home, args, extra = {}) {
  return run(process.execPath, [installedCli, ...args], {
    cwd: home.path,
    env: home.env,
    timeout: 35_000,
    maxBuffer: 4 * 1024 * 1024,
    ...extra,
  });
}

async function makeHome(name, sessions) {
  const path = join(temporary, name);
  await mkdir(path);
  const env = {
    ...process.env,
    MCPC_HOME_DIR: path,
    NAPI_RS_NATIVE_LIBRARY_PATH: join(path, 'deliberately-unavailable-keyring.node'),
    NO_COLOR: '1',
    // Any unintended external HTTP request fails; every fixture is loopback.
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost',
    http_proxy: 'http://127.0.0.1:1',
    https_proxy: 'http://127.0.0.1:1',
    no_proxy: '127.0.0.1,localhost',
  };
  const home = { path, env, sessions };
  homes.push(home);
  return home;
}

async function session(home, name) {
  return JSON.parse(await readFile(join(home.path, 'sessions.json'), 'utf8')).sessions[name];
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function install(directory, withBash) {
  await mkdir(directory);
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: withBash ? 'mcpc-bash-consumer' : 'mcpc-cli-consumer',
      private: true,
      type: 'module',
      dependencies: {
        '@apify/mcpc': `file:${archive}`,
        ...(withBash && {
          'just-bash': packageInfo.devDependencies['just-bash'],
          '@types/node': packageInfo.devDependencies['@types/node'],
        }),
      },
    })
  );
  await copyFile(join(repo, 'pnpm-workspace.yaml'), join(directory, 'pnpm-workspace.yaml'));
  const args = [pnpm, 'install', '--reporter=append-only'];
  if (process.env.MCPC_JUST_BASH_OFFLINE) args.push('--offline');
  if (process.env.npm_config_store_dir) args.push('--store-dir', process.env.npm_config_store_dir);
  if (process.env.npm_config_cache_dir) args.push('--cache-dir', process.env.npm_config_cache_dir);
  await run(process.execPath, args, {
    cwd: directory,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return createRequire(join(directory, 'package.json'));
}

try {
  await run(process.execPath, [pnpm, 'pack', '--out', archive], { cwd: repo, timeout: 60_000 });
  const consumer = join(temporary, 'consumer');
  const requireConsumer = await install(consumer, true);
  const packageEntry = requireConsumer.resolve('@apify/mcpc');
  installedCli = join(dirname(packageEntry), 'cli/index.js');
  const { createMcpcJustBashCommand, mcpcJustBashCommand } = await import(
    pathToFileURL(packageEntry)
  );
  const { Bash, createCommandContext, InMemoryFs, encodeUtf8ToBytes } = await import(
    pathToFileURL(requireConsumer.resolve('just-bash'))
  );
  assert(!packageEntry.startsWith(join(repo, 'dist')), 'must load the packed consumer');
  const directContext = (signal) =>
    createCommandContext({
      fs: new InMemoryFs(),
      stdin: encodeUtf8ToBytes(''),
      ...(signal && { signal }),
    });
  const grant = (commands) => ({ authority: 'full-session-lifecycle', commands });
  const home = await makeHome('sessions', [label, secondLabel]);
  const homeHttp = await makeHome('http-session', [httpLabel]);
  const config = join(temporary, 'mcp.json');
  await writeFile(
    config,
    JSON.stringify({
      mcpServers: {
        local: {
          command: process.execPath,
          args: [stdioFixture, eventsPath],
          env: { JUST_BASH_HOST_SECRET: 'owned-test-value' },
        },
      },
    })
  );
  const proxyPort = await unusedPort();
  await cli(home, [
    'connect',
    `${config}:local`,
    label,
    '--proxy',
    `127.0.0.1:${proxyPort}`,
    '--proxy-bearer-token',
    'owned-proxy-token',
  ]);
  await cli(home, ['connect', `${config}:local`, secondLabel]);
  const sessions = {
    [label]: grant(['info', 'tools-list', 'tools-get', 'tools-call', 'resources-read']),
    [secondLabel]: grant(['tools-list', 'tools-call']),
  };
  const adapter = createMcpcJustBashCommand({
    homeDir: home.path,
    env: home.env,
    cwd: home.path,
    sessions,
    timeoutMillis: 25_000,
  });
  const bash = new Bash({ customCommands: [adapter] });

  await check('packed consumer import and TypeScript declarations link to just-bash', async () => {
    await writeFile(
      join(consumer, 'consumer.ts'),
      `import { Bash } from 'just-bash';\nimport { createMcpcJustBashCommand, mcpcJustBashCommand, type McpcJustBashOptions } from '@apify/mcpc';\nconst options: McpcJustBashOptions = { homeDir: '/host/provisioned', sessions: { '@server': { authority: 'full-session-lifecycle', commands: ['tools-list'] } } };\nconst shell = new Bash({customCommands: [mcpcJustBashCommand, createMcpcJustBashCommand(options)]});\nvoid shell;\n`
    );
    await run(
      process.execPath,
      [
        join(repo, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--target',
        'ES2022',
        join(consumer, 'consumer.ts'),
      ],
      { cwd: consumer, timeout: 60_000 }
    );
    assert.equal(
      (await mcpcJustBashCommand.execute([label, 'tools-list'], directContext())).exitCode,
      1
    );
  });

  await check('real Bash.exec JSON stdin and Unicode pipe retain bytes', async () => {
    const result = await bash.exec(
      `printf '%s' '{"text":"café 🌍"}' | mcpc ${label} tools-call echo --json | jq -r '.content[0].text'`
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { text: 'café 🌍' });
  });

  await check('binary resource redirection writes only the virtual filesystem', async () => {
    const result = await bash.exec(
      `mcpc ${label} resources-read fixture://binary --raw > /result.bin`
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(Buffer.from(await bash.fs.readFileBuffer('/result.bin')), BINARY);
    const denied = await bash.exec(
      `mcpc ${label} resources-read fixture://binary -o ${join(home.path, 'forbidden')}`
    );
    assert.equal(denied.exitCode, 1);
    await assert.rejects(readFile(join(home.path, 'forbidden')), { code: 'ENOENT' });
  });

  await check(
    'guest environment, cwd, PATH, and shell metacharacters cannot redirect host authority',
    async () => {
      const result = await bash.exec(
        `mkdir -p /guest; cd /guest; MCPC_HOME_DIR=/guest HOME=/guest PATH=/guest NODE_OPTIONS=--import=/guest/evil.mjs HTTPS_PROXY=http://guest.invalid mcpc ${label} tools-call env name:=JUST_BASH_HOST_SECRET --json`
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).content[0].text, 'owned-test-value');
      const literal = 'value:=hello; $(touch /host/never) `whoami` @other';
      const echo = await adapter.execute(
        [label, 'tools-call', 'echo', literal, '--json'],
        directContext()
      );
      assert.equal(echo.exitCode, 0, echo.stderr);
      assert.equal(
        JSON.parse(echo.stdout).content[0].text,
        JSON.stringify({ value: literal.slice(7) })
      );
    }
  );

  await check(
    'ungranted commands and collections cause no fixture request or bridge recovery',
    async () => {
      const before = await events();
      const restricted = createMcpcJustBashCommand({
        homeDir: home.path,
        env: home.env,
        sessions: { [label]: grant(['tools-list']), [secondLabel]: grant([]) },
      });
      assert.equal(
        (await restricted.execute([label, 'tools/call', 'echo'], directContext())).exitCode,
        1
      );
      const incomplete = createMcpcJustBashCommand({
        homeDir: home.path,
        env: home.env,
        sessions: { [label]: grant(['tools-list']) },
      });
      assert.equal((await incomplete.execute([label, 'tools-list'], directContext())).exitCode, 1);
      assert.deepEqual(await events(), before);
      assert.deepEqual(restricted.getAccessedSessions(), []);
      assert.deepEqual(incomplete.getAccessedSessions(), []);
    }
  );

  await check('CLI error status and separate stderr survive the adapter', async () => {
    const failure = await adapter.execute([label, 'tools-call', 'fail', '--json'], directContext());
    assert.equal(failure.exitCode, 2);
    assert.equal(JSON.parse(failure.stdout).isError, true);
  });

  await check(
    'dead stdio bridge recovery retains saved env and protected proxy authority',
    async () => {
      const old = await session(home, label);
      process.kill(old.pid, 'SIGKILL');
      await eventually(async () => !(await alive(old.pid)), 'old bridge did not exit');
      const recovered = await adapter.execute(
        [label, 'tools-call', 'env', 'name:=JUST_BASH_HOST_SECRET', '--json'],
        directContext()
      );
      assert.equal(recovered.exitCode, 0, recovered.stderr);
      assert.equal(JSON.parse(recovered.stdout).content[0].text, 'owned-test-value');
      assert.notEqual((await session(home, label)).pid, old.pid);
      assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/health`)).status, 200);
      assert.equal(
        (await fetch(`http://127.0.0.1:${proxyPort}/mcp`, { method: 'POST', body: '{}' })).status,
        401
      );
    }
  );

  await check(
    'in-flight socket loss recovers the bridge without replaying a side-effecting tool',
    async () => {
      const before = (await events()).filter((event) => event.name === 'break').length;
      const old = await session(home, label);
      const result = await adapter.execute(
        [label, 'tools-call', 'break', '--json'],
        directContext()
      );
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /in flight|may or may not/);
      assert.notEqual((await session(home, label)).pid, old.pid);
      assert.equal((await events()).filter((event) => event.name === 'break').length, before + 1);
    }
  );

  await check(
    'cancellation owns only its CLI; concurrent invocation and host bridges survive',
    async () => {
      const saved = await session(home, label);
      const otherSaved = await session(home, secondLabel);
      const savedAlive = await alive(saved.pid);
      const otherSavedAlive = await alive(otherSaved.pid);
      const cancelBarrier = join(home.path, 'release-cancel');
      const independentBarrier = join(home.path, 'release-independent');
      const controller = new AbortController();
      const pending = adapter.execute(
        [label, 'tools-call', 'wait', `barrier:=${cancelBarrier}`, 'marker:=cancel', '--json'],
        directContext(controller.signal)
      );
      let otherSettled = false;
      const other = adapter
        .execute(
          [
            secondLabel,
            'tools-call',
            'wait',
            `barrier:=${independentBarrier}`,
            'marker:=independent',
            '--json',
          ],
          directContext()
        )
        .finally(() => {
          otherSettled = true;
        });
      try {
        // Both calls must have finished CLI health/recovery and reached their
        // actual MCP workers before cancellation. A saved setup PID can be
        // replaced during normal recovery, independently of this abort.
        await eventually(async () => {
          const calls = (await events()).filter((event) => event.event === 'call');
          return (
            calls.some((event) => event.marker === 'cancel') &&
            calls.some((event) => event.marker === 'independent')
          );
        }, 'both concurrent calls did not reach their fixture barriers');
        const calls = (await events()).filter((event) => event.event === 'call');
        const prior = await session(home, label);
        const otherPrior = await session(home, secondLabel);
        assert.equal(calls.find((event) => event.marker === 'cancel').bridgePid, prior.pid);
        assert.equal(
          calls.find((event) => event.marker === 'independent').bridgePid,
          otherPrior.pid
        );
        assert.notEqual(prior.pid, otherPrior.pid);
        assert(await alive(prior.pid));
        assert(await alive(otherPrior.pid));
        if (prior.pid !== saved.pid || otherPrior.pid !== otherSaved.pid) {
          console.log('info - bridge recovery completed before cancellation', {
            saved: { pid: saved.pid, alive: savedAlive, activePid: prior.pid },
            otherSaved: { pid: otherSaved.pid, alive: otherSavedAlive, activePid: otherPrior.pid },
          });
        }
        controller.abort();
        assert.equal((await pending).exitCode, 130);
        assert.equal(otherSettled, false, 'cancellation must leave the other blocked CLI running');
        assert.equal((await session(home, label)).pid, prior.pid);
        assert.equal((await session(home, secondLabel)).pid, otherPrior.pid);
        assert(await alive(prior.pid));
        assert(await alive(otherPrior.pid));
        await writeFile(independentBarrier, 'release');
        const completed = await other;
        assert.equal(completed.exitCode, 0, completed.stderr);
        assert.match(completed.stdout, /independent/);
        assert.equal((await session(home, label)).pid, prior.pid);
        assert.equal((await session(home, secondLabel)).pid, otherPrior.pid);
        assert(await alive(prior.pid));
        assert(await alive(otherPrior.pid));
      } finally {
        await writeFile(cancelBarrier, 'release');
        await writeFile(independentBarrier, 'release');
        await Promise.allSettled([pending, other]);
      }
      await eventually(
        async () =>
          (await events()).some((event) => event.event === 'finished' && event.marker === 'cancel'),
        'host-owned canceled tool did not finish after its barrier was released'
      );
      assert.deepEqual(new Set(adapter.getAccessedSessions()), new Set([label, secondLabel]));
    }
  );

  await check('real output capture stops at the configured byte bound', async () => {
    const limited = createMcpcJustBashCommand({
      homeDir: home.path,
      env: home.env,
      sessions,
      maxOutputBytes: 2048,
    });
    const result = await limited.execute(
      [label, 'resources-read', 'fixture://large', '--raw'],
      directContext()
    );
    assert.equal(result.exitCode, 125);
    assert(result.stdout.length <= 2048);
    assert.match(result.stderr, /output limit/);
  });

  for (const phase of ['initial', 'recovery']) {
    await check(
      `cancellation during ${phase} connection keeps the new bridge in host ownership`,
      async () => {
        const name = `${label}-${phase}`;
        const delayedHome = await makeHome(`delayed-${phase}`, [name]);
        const initializeBarrier = join(delayedHome.path, 'allow-initialize');
        const template = structuredClone(await session(home, label));
        template.name = name;
        template.server.args = [stdioFixture, eventsPath, initializeBarrier];
        delete template.server.env;
        delete template.proxy;
        delete template.pid;
        delete template.mcpSessionId;
        if (phase === 'initial') delete template.lastSeenAt;
        template.status = phase === 'initial' ? 'connecting' : 'crashed';
        await writeFile(
          join(delayedHome.path, 'sessions.json'),
          JSON.stringify({ sessions: { [name]: template } })
        );
        const delayedAdapter = createMcpcJustBashCommand({
          homeDir: delayedHome.path,
          env: delayedHome.env,
          sessions: { [name]: grant(['tools-list']) },
        });
        const controller = new AbortController();
        const pending = delayedAdapter.execute(
          [name, 'tools-list', '--json'],
          directContext(controller.signal)
        );
        let bridge;
        try {
          await eventually(
            async () =>
              (await events()).some((event) => event.barrier === initializeBarrier) &&
              typeof (await session(delayedHome, name)).pid === 'number',
            'delayed bridge was not registered at the initialization barrier'
          );
          bridge = await session(delayedHome, name);
          controller.abort();
          assert.equal((await pending).exitCode, 130);
          assert.deepEqual(delayedAdapter.getAccessedSessions(), [name]);
          assert(await alive(bridge.pid), 'the host-owned initializing bridge must not be killed');
        } finally {
          controller.abort();
          await writeFile(initializeBarrier, 'continue');
          await Promise.allSettled([pending]);
        }
        const recovered = await delayedAdapter.execute(
          [name, 'tools-list', '--json'],
          directContext()
        );
        assert.equal(recovered.exitCode, 0, recovered.stderr);
        assert.equal((await session(delayedHome, name)).pid, bridge.pid);
      }
    );
  }

  await check(
    'saved HTTP credentials and zero-value local x402 authority survive recovery only with a full grant',
    async () => {
      httpFixture = await startHttpFixture('owned-http-token');
      await cli(homeHttp, ['x402', 'init', '--json']);
      await cli(homeHttp, [
        'connect',
        httpFixture.url,
        httpLabel,
        '--header',
        'Authorization: Bearer owned-http-token',
        '--x402',
        'exact',
      ]);
      const paymentAdapter = createMcpcJustBashCommand({
        homeDir: homeHttp.path,
        env: homeHttp.env,
        sessions: { [httpLabel]: grant(['tools-list', 'tools-call']) },
      });
      const old = await session(homeHttp, httpLabel);
      process.kill(old.pid, 'SIGKILL');
      await eventually(async () => !(await alive(old.pid)), 'old HTTP bridge did not exit');
      const denied = createMcpcJustBashCommand({ homeDir: homeHttp.path, env: homeHttp.env });
      const before = httpFixture.events.length;
      assert.equal(
        (await denied.execute([httpLabel, 'tools-call', 'paid'], directContext())).exitCode,
        1
      );
      assert.equal(httpFixture.events.length, before);
      assert.equal((await session(homeHttp, httpLabel)).pid, old.pid);
      const result = await paymentAdapter.execute(
        [httpLabel, 'tools-call', 'paid', '--json'],
        directContext()
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(
        httpFixture.events.filter((event) => event.event === 'verified-payment').length,
        1
      );
      assert.equal(
        httpFixture.events.filter(
          (event) => event.event === 'unauthorized' || event.event === 'fixture-error'
        ).length,
        0
      );
      assert.notEqual((await session(homeHttp, httpLabel)).pid, old.pid);
    }
  );

  await check(
    'CLI and package import work without the optional just-bash peer installed',
    async () => {
      const plain = join(temporary, 'plain');
      const requirePlain = await install(plain, false);
      const entry = requirePlain.resolve('@apify/mcpc');
      const requireInstalled = createRequire(entry);
      assert.throws(() => requireInstalled.resolve('just-bash'), { code: 'MODULE_NOT_FOUND' });
      const result = await run(
        process.execPath,
        [join(dirname(entry), 'cli/index.js'), '--version'],
        { timeout: 15_000 }
      );
      assert.equal(result.stdout.trim(), packageInfo.version);
      await run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import { mcpcJustBashCommand } from '@apify/mcpc'; if (mcpcJustBashCommand.name !== 'mcpc') process.exit(1)",
        ],
        { cwd: plain, timeout: 15_000 }
      );
    }
  );
} finally {
  for (const home of homes) {
    for (const name of home.sessions) {
      await cli(home, [name, 'close']).catch(() => {});
    }
  }
  await httpFixture?.close();
  const fixturePids = [
    ...new Set(
      (await events()).filter((event) => event.event === 'start').map((event) => event.pid)
    ),
  ];
  await eventually(
    async () => (await Promise.all(fixturePids.map(alive))).every((running) => !running),
    'an owned stdio fixture remained after host teardown'
  );
  if (process.platform === 'linux' && installedCli) {
    const remaining = [];
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      if (command.includes(installedCli) && command.includes(label)) remaining.push(pid);
    }
    assert.deepEqual(remaining, [], 'no owned CLI processes may remain after cancellation/failure');
  }
  await rm(temporary, { recursive: true, force: true });
}
console.log(
  `${checks} packed integration checks passed; all owned sessions and processes cleaned up`
);
