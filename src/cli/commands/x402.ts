/**
 * x402 wallet management and payment signing commands
 */

import { Command } from 'commander';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import {
  base,
  createPublicClient,
  erc20Abi,
  formatEther,
  formatUnits,
  generatePrivateKey,
  http,
  privateKeyToAccount,
  type Hex,
} from '../../lib/x402/viem.js';
import {
  formatSuccess,
  formatError,
  formatInfo,
  formatWarning,
  formatJson,
  jsonHelp,
  theme,
} from '../output.js';
import { getWallet, saveWallet, removeWallet } from '../../lib/wallets.js';
import { ClientError, isMcpError } from '../../lib/errors.js';
import { getJsonFromEnv } from '../parser.js';
import type { OutputMode } from '../../lib/types.js';
import { signPayment, parsePaymentRequired } from '../../lib/x402/signer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USDC_DECIMALS = 6;

/**
 * Pad the fractional part of a decimal string so it always shows at least
 * `minDecimals` places (e.g. "1" → "1.000000"), keeping any extra precision.
 */
function padDecimals(value: string, minDecimals: number): string {
  const [intPart, fracPart = ''] = value.split('.');
  return `${intPart}.${fracPart.padEnd(minDecimals, '0')}`;
}

/**
 * Generate a QR code string for the given text using small (half-block) mode.
 */
function generateQrCode(text: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(text, { small: true }, (code) => {
      resolve(code);
    });
  });
}

/**
 * Print a QR code for an Ethereum address so the user can scan it to fund the wallet.
 */
async function printAddressQrCode(address: string): Promise<void> {
  const qr = await generateQrCode(address);
  console.log('');
  console.log(chalk.bold('  Scan with your crypto payment app to fund this wallet:'));
  console.log(
    chalk.whiteBright(
      qr
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')
    )
  );
}

// ---------------------------------------------------------------------------
// Command: init
// ---------------------------------------------------------------------------

async function initWallet(options: { outputMode: OutputMode }): Promise<void> {
  const existing = await getWallet();
  if (existing) {
    throw new ClientError(
      `Wallet already exists (address: ${existing.address}). Use "mcpc x402 remove" first.`
    );
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  await saveWallet({
    address: account.address,
    privateKey,
    createdAt: new Date().toISOString(),
  });

  if (options.outputMode === 'json') {
    console.log(formatJson({ address: account.address }));
  } else {
    console.log(
      formatWarning(
        'x402 support is experimental. Use at your own risk — funds sent to this wallet may be lost.'
      )
    );
    console.log('');
    console.log(formatSuccess('Wallet created'));
    console.log(formatInfo(`Address: ${theme.cyan(account.address)}`));
    console.log(formatInfo('Fund this address with USDC on Base to use x402 payments.'));
    await printAddressQrCode(account.address);
  }
}

// ---------------------------------------------------------------------------
// Command: import
// ---------------------------------------------------------------------------

async function importWallet(options: {
  privateKey: string;
  outputMode: OutputMode;
}): Promise<void> {
  const existing = await getWallet();
  if (existing) {
    throw new ClientError(
      `Wallet already exists (address: ${existing.address}). Use "mcpc x402 remove" first.`
    );
  }

  let key = options.privateKey.trim();
  if (!key.startsWith('0x')) key = `0x${key}`;

  let account;
  try {
    account = privateKeyToAccount(key as Hex);
  } catch {
    throw new ClientError(
      'Invalid private key. Must be a 64-character hex string (with or without 0x prefix).'
    );
  }

  await saveWallet({
    address: account.address,
    privateKey: key,
    createdAt: new Date().toISOString(),
  });

  if (options.outputMode === 'json') {
    console.log(formatJson({ address: account.address }));
  } else {
    console.log(
      formatWarning(
        'x402 support is experimental. Use at your own risk — funds sent to this wallet may be lost.'
      )
    );
    console.log('');
    console.log(formatSuccess('Wallet imported'));
    console.log(formatInfo(`Address: ${theme.cyan(account.address)}`));
    console.log(formatInfo('Fund this address with USDC on Base to use x402 payments.'));
    await printAddressQrCode(account.address);
  }
}

// ---------------------------------------------------------------------------
// Command: info
// ---------------------------------------------------------------------------

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function walletInfo(options: {
  outputMode: OutputMode;
  showUsageHint?: boolean;
}): Promise<void> {
  const wallet = await getWallet();

  if (!wallet) {
    if (options.outputMode === 'json') {
      console.log(formatJson(null));
    } else {
      console.log(formatInfo('No wallet configured. Create one with: mcpc x402 init'));
      if (options.showUsageHint) {
        console.log(chalk.dim('For usage information, run: mcpc help x402'));
      }
    }
    return;
  }

  const publicClient = createPublicClient({
    chain: base,
    transport: http('https://mainnet.base.org'),
  });

  let ethBalance = '0';
  let usdcBalance = '0';
  let balanceError = false;

  try {
    const [eth, usdc] = await Promise.all([
      publicClient.getBalance({ address: wallet.address as Hex }),
      publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet.address as Hex],
      }),
    ]);

    ethBalance = formatEther(eth);
    usdcBalance = formatUnits(usdc, USDC_DECIMALS);
  } catch {
    balanceError = true;
  }

  if (options.outputMode === 'json') {
    console.log(
      formatJson({
        address: wallet.address,
        createdAt: wallet.createdAt,
        balances: balanceError
          ? null
          : {
              eth: ethBalance,
              usdc: usdcBalance,
            },
      })
    );
    return;
  }

  console.log(`  ${chalk.bold('Address')}        ${theme.cyan(wallet.address)}`);
  console.log(`  ${chalk.bold('Created')}        ${wallet.createdAt}`);
  if (!balanceError) {
    console.log(`  ${chalk.bold('ETH balance')}    ${padDecimals(ethBalance, 6)}`);
    console.log(`  ${chalk.bold('USDC balance')}   ${padDecimals(usdcBalance, 6)}`);
  } else {
    console.log(`  ${theme.red('Failed to fetch balances')}`);
  }
  await printAddressQrCode(wallet.address);
  if (options.showUsageHint) {
    console.log('');
    console.log(chalk.dim('For usage information, run: mcpc help x402'));
  }
}

// ---------------------------------------------------------------------------
// Command: remove
// ---------------------------------------------------------------------------

async function removeWalletCmd(options: { outputMode: OutputMode }): Promise<void> {
  const removed = await removeWallet();
  if (!removed) {
    throw new ClientError('No wallet configured.');
  }

  if (options.outputMode === 'json') {
    console.log(formatJson({ removed: true }));
  } else {
    console.log(formatSuccess('Wallet removed.'));
  }
}

// ---------------------------------------------------------------------------
// Command: sign
// ---------------------------------------------------------------------------

interface SignOptions {
  paymentRequired: string;
  amount: string | undefined;
  expiry: string | undefined;
  scheme: string | undefined;
  noApprove: boolean | undefined;
  outputMode: OutputMode;
}

async function signPaymentCommand(options: SignOptions): Promise<void> {
  const wallet = await getWallet();
  if (!wallet) {
    throw new ClientError('No wallet configured. Create one with: mcpc x402 init');
  }

  // Resolve scheme preference
  const schemePreference =
    options.scheme === 'upto' || options.scheme === 'exact' || options.scheme === 'auto'
      ? options.scheme
      : 'auto';

  // Parse PAYMENT-REQUIRED header
  const { header, accept } = parsePaymentRequired(options.paymentRequired, schemePreference);

  // Resolve overrides
  let amountOverride: bigint | undefined;
  if (options.amount) {
    const amountUsd = parseFloat(options.amount);
    if (isNaN(amountUsd) || amountUsd <= 0)
      throw new ClientError('--amount must be a positive number.');
    amountOverride = BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS));
  }

  let expiryOverrideSecs: number | undefined;
  if (options.expiry) {
    expiryOverrideSecs = parseInt(options.expiry, 10);
    if (isNaN(expiryOverrideSecs) || expiryOverrideSecs <= 0) {
      throw new ClientError('--expiry must be a positive number of seconds.');
    }
  }

  // Sign using shared signer
  const result = await signPayment({
    wallet: { privateKey: wallet.privateKey, address: wallet.address },
    accept,
    resource: header.resource,
    ...(amountOverride !== undefined && { amountOverride }),
    ...(expiryOverrideSecs !== undefined && { expiryOverrideSecs }),
    ...(options.noApprove === true && { skipPermit2Approval: true }),
  });

  if (options.outputMode === 'json') {
    console.log(
      formatJson({
        paymentSignature: result.paymentSignatureBase64,
        from: result.from,
        to: result.to,
        amount: result.amountUsd,
        amountAtomicUnits: result.amountAtomicUnits.toString(),
        network: result.networkLabel,
        expiresAt: result.expiresAt.toISOString(),
      })
    );
    return;
  }

  // Human output
  const resourceUrl = (header.resource?.url ?? 'https://mcp.apify.com/mcp').replace(/\?.*$/, '');

  console.log(formatSuccess('Payment signed'));
  console.log(formatInfo(`Wallet    : ${result.from}`));
  console.log(formatInfo(`Network   : ${result.networkLabel}`));
  console.log(formatInfo(`To        : ${result.to}`));
  console.log(
    formatInfo(
      `Amount    : $${result.amountUsd.toFixed(2)} (${result.amountAtomicUnits.toString()} atomic units)`
    )
  );
  console.log(formatInfo(`Expires   : ${result.expiresAt.toISOString()}`));
  console.log('');
  console.log(chalk.bold('  PAYMENT-SIGNATURE header:'));
  console.log(`  ${result.paymentSignatureBase64}`);
  console.log('');
  console.log(chalk.bold('  MCP config snippet:'));
  console.log(
    JSON.stringify(
      {
        mcp: {
          'apify-x402': {
            type: 'remote',
            url: `${resourceUrl}?payment=x402`,
            headers: { 'PAYMENT-SIGNATURE': result.paymentSignatureBase64 },
          },
        },
      },
      null,
      2
    )
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n')
  );
  console.log('');
}

// ---------------------------------------------------------------------------
// Top-level x402 command router
// ---------------------------------------------------------------------------

export async function handleX402Command(args: string[]): Promise<void> {
  const program = new Command();
  program
    .name('mcpc x402')
    .description('x402 wallet management and payment signing (EXPERIMENTAL)');

  // Match the help width of the other mcpc programs, so descriptions stay on one line
  program.configureOutput({
    getOutHelpWidth: () => 100,
    getErrHelpWidth: () => 100,
  });

  program.configureHelp({
    styleTitle: (str) => chalk.bold(str),
    styleSubcommandText: (str) => theme.cyan(str),
  });

  // Inherit global options so they parse correctly
  program
    .option('--json', 'Output in JSON format')
    .option('--verbose', 'Enable debug logging')
    .helpOption('-h, --help', 'Display help')
    .helpCommand('help [command]', 'Display help for command')
    .addHelpText(
      'after',
      `
${chalk.bold('sign options:')}
  --amount <usd>         Override amount in USD (for upto: max authorization cap)
  --expiry <seconds>     Override expiry in seconds
  --scheme <preference>  Payment scheme: auto (default), upto, or exact
  --no-approve           Skip the upto Permit2 allowance check & auto-approval
${jsonHelp('`{ address, createdAt, balances: { eth, usdc } | null }` (null if no wallet)')}`
    );

  const resolveOutputMode = (cmd: Command): OutputMode => {
    const opts = cmd.optsWithGlobals();
    return opts.json ? 'json' : 'human';
  };

  // Bare "mcpc x402" (no subcommand): show wallet info (or how to create one) plus a
  // usage hint. Use "mcpc help x402" / "mcpc x402 --help" for the full command reference.
  program.action(async (_opts, cmd: Command) => {
    await walletInfo({ outputMode: resolveOutputMode(cmd), showUsageHint: true });
  });

  program
    .command('init')
    .description('Create a new x402 wallet (generates a random private key)')
    .addHelpText('after', jsonHelp('`{ address }`'))
    .action(async (_opts, cmd) => {
      await initWallet({ outputMode: resolveOutputMode(cmd) });
    });

  program
    .command('import <private-key>')
    .description('Import an existing wallet from a private key')
    .addHelpText('after', jsonHelp('`{ address }`'))
    .action(async (privateKey, _opts, cmd) => {
      await importWallet({ privateKey, outputMode: resolveOutputMode(cmd) });
    });

  // Deprecated: "mcpc x402 info" is superseded by bare "mcpc x402".
  // Hidden from help; emits a warning and will be removed in a future release.
  program
    .command('info', { hidden: true })
    .description('Show wallet info (deprecated: use "mcpc x402")')
    .addHelpText(
      'after',
      jsonHelp('`{ address, createdAt, balances: { eth, usdc } | null }` (null if no wallet)')
    )
    .action(async (_opts, cmd) => {
      const outputMode = resolveOutputMode(cmd);
      if (outputMode !== 'json') {
        console.error(
          formatWarning(
            '"mcpc x402 info" is deprecated and will be removed in a future release. Run "mcpc x402" instead.'
          )
        );
      }
      await walletInfo({ outputMode });
    });

  program
    .command('remove')
    .description('Remove the wallet')
    .addHelpText('after', jsonHelp('`{ removed: true }`'))
    .action(async (_opts, cmd) => {
      await removeWalletCmd({ outputMode: resolveOutputMode(cmd) });
    });

  program
    .command('sign <payment-required>')
    .description('Sign a payment from a base64 PAYMENT-REQUIRED header')
    .helpOption('-h, --help', 'Display help')
    .option('--amount <usd>', 'Override amount in USD (for upto: max authorization cap)')
    .option('--expiry <seconds>', 'Override expiry in seconds')
    // No "(default: auto)" in the text — Commander appends the default value itself
    .option('--scheme <auto|upto|exact>', 'Payment scheme preference', 'auto')
    .option('--no-approve', 'Skip the upto Permit2 allowance check & auto-approval')
    .addHelpText(
      'after',
      `
Signs the given base64-encoded PAYMENT-REQUIRED header offline using the configured
wallet and prints the resulting PAYMENT-SIGNATURE header (plus an MCP config snippet)
to stdout. Useful for pre-signing payments or integrating with other MCP clients.
${jsonHelp('`{ paymentSignature, from, to, amount, amountAtomicUnits, network, expiresAt }`')}`
    )
    .action(
      async (
        paymentRequired,
        opts: { amount?: string; expiry?: string; scheme?: string; approve?: boolean },
        cmd
      ) => {
        // Commander turns --no-approve into opts.approve = false
        await signPaymentCommand({
          paymentRequired,
          amount: opts.amount,
          expiry: opts.expiry,
          scheme: opts.scheme,
          noApprove: opts.approve === false,
          outputMode: resolveOutputMode(cmd),
        });
      }
    );

  try {
    await program.parseAsync(['node', 'mcpc-x402', ...args]);
  } catch (error) {
    if (isMcpError(error)) {
      // Respect --json/MCPC_JSON for machine-readable errors, and preserve the
      // error's own exit code instead of flattening everything to 1.
      const jsonMode = args.includes('--json') || getJsonFromEnv();
      if (jsonMode) {
        console.error(formatJson({ error: error.message, code: error.code }));
      } else {
        console.error(formatError(error.message));
      }
      process.exit(error.code);
    }
    throw error;
  }
}
