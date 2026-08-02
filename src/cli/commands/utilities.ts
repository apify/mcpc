/**
 * Server-level commands (ping, server-discover, etc.)
 */

import chalk from 'chalk';
import { formatSuccess, formatOutput, formatDiscoverResult } from '../output.js';
import { withMcpClient } from '../helpers.js';
import { ServerError } from '../../lib/errors.js';
import { isModernProtocolVersion, discoverUnavailableMessage } from '../../core/protocol.js';
import type { CommandOptions } from '../../lib/types.js';

/**
 * Ping the MCP server to check if it's alive
 */
export async function ping(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client, context) => {
    const { protocolVersion } = context;
    const isModern = !!protocolVersion && isModernProtocolVersion(protocolVersion);

    const startTime = performance.now();
    await client.ping();
    const endTime = performance.now();
    const durationMillis = Math.round(endTime - startTime);

    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Ping successful (${durationMillis}ms)`));
      // Say which request actually measured the roundtrip: MCP 2026-07-28 has no `ping`,
      // so a --verbose log or the server's access log shows server/discover instead.
      if (isModern) {
        console.log(
          chalk.dim(`MCP ${protocolVersion} has no ping request; probed with server/discover.`)
        );
        console.log(chalk.dim(`↳ see the full result: mcpc ${target} server-discover`));
      }
    } else {
      console.log(
        formatOutput(
          {
            success: true,
            durationMs: durationMillis, // field name is part of the --json output API
          },
          'json'
        )
      );
    }
  });
}

/**
 * Send a `server/discover` request and report what the server advertises.
 *
 * 2026-07-28 and later only. The equivalent data on a legacy connection comes from the
 * `initialize` handshake, which mcpc already reports via `mcpc @session` — refuse here
 * (with that pointer) rather than passing off cached handshake data as a discover result.
 */
export async function serverDiscover(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    // Gate on the negotiated version before sending anything, so the reason names this
    // session and its version. The core client repeats the check as a backstop.
    const details = await client.getServerDetails();
    if (details.protocolVersion && !isModernProtocolVersion(details.protocolVersion)) {
      throw new ServerError(discoverUnavailableMessage(details.protocolVersion, target));
    }

    const result = await client.discover();

    if (options.outputMode === 'human') {
      console.log(formatDiscoverResult(result, target, details.protocolVersion));
    } else {
      console.log(formatOutput(result, 'json'));
    }
  });
}
