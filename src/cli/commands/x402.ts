/**
 * x402 wallet management and payment signing commands
 */

import { Command } from 'commander';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, formatEther, formatUnits, erc20Abi, type Hex } from 'viem';
import { base } from 'viem/chains';
import {
  formatSuccess,
  formatError,
  formatInfo,
  formatWarning,
  formatJson,
  theme,
} from '../output.js';
import { getWallet, saveWallet, removeWallet } from '../../lib/wallets.js';
import { ClientError } from '../../lib/errors.js';
import type { OutputMode } from '../../lib/types.js';
import { signPayment, parsePaymentRequired } from '../../lib/x402/signer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USDC_DECIMALS = 6;

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
  console.log(chalk.bold('  Scan to fund this wallet:'));
  console.log(
    qr
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
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

async function walletInfo(options: { outputMode: OutputMode }): Promise<void> {
  const wallet = await getWallet();

  if (!wallet) {
    if (options.outputMode === 'json') {
      console.log(formatJson(null));
    } else {
      console.log(formatInfo('No wallet configured. Create one with: mcpc x402 init'));
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
  } catch (err) {
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
    console.log(`  ${chalk.bold('ETH Balance')}    ${ethBalance}`);
    console.log(`  ${chalk.bold('USDC Balance')}   ${usdcBalance}`);
  } else {
    console.log(`  ${chalk.bold('Balances')}       ${theme.red('Failed to fetch')}`);
  }
  await printAddressQrCode(wallet.address);
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
  amount?: string;
  expiry?: string;
  outputMode: OutputMode;
}

async function signPaymentCommand(options: SignOptions): Promise<void> {
  const wallet = await getWallet();
  if (!wallet) {
    throw new ClientError('No wallet configured. Create one with: mcpc x402 init');
  }

  // Parse PAYMENT-REQUIRED header
  const { header, accept } = parsePaymentRequired(options.paymentRequired);

  // Resolve overrides
  let amountOverride: bigint | undefined;
  if (options.amount) {
    const amountUsd = parseFloat(options.amount);
    if (isNaN(amountUsd) || amountUsd <= 0)
      throw new ClientError('--amount must be a positive number.');
    amountOverride = BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS));
  }

  const expiryOverride = options.expiry ? parseInt(options.expiry, 10) : undefined;

  // Sign using shared signer
  const result = await signPayment({
    wallet: { privateKey: wallet.privateKey, address: wallet.address },
    accept,
    resource: header.resource,
    ...(amountOverride !== undefined && { amountOverride }),
    ...(expiryOverride !== undefined && { expiryOverride }),
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
  --amount <usd>      Override amount in USD
  --expiry <seconds>  Override expiry in seconds`
    );

  const resolveOutputMode = (cmd: Command): OutputMode => {
    const opts = cmd.optsWithGlobals();
    return opts.json ? 'json' : 'human';
  };

  program
    .command('init')
    .description('Create a new x402 wallet')
    .action(async (_opts, cmd) => {
      await initWallet({ outputMode: resolveOutputMode(cmd) });
    });

  program
    .command('import <private-key>')
    .description('Import an existing wallet from a private key')
    .action(async (privateKey, _opts, cmd) => {
      await importWallet({ privateKey, outputMode: resolveOutputMode(cmd) });
    });

  program
    .command('info')
    .description('Show wallet info')
    .action(async (_opts, cmd) => {
      await walletInfo({ outputMode: resolveOutputMode(cmd) });
    });

  program
    .command('remove')
    .description('Remove the wallet')
    .action(async (_opts, cmd) => {
      await removeWalletCmd({ outputMode: resolveOutputMode(cmd) });
    });

  program
    .command('sign <payment-required>')
    .description('Sign a payment using the wallet')
    .helpOption('-h, --help', 'Display help')
    .option('--amount <usd>', 'Override amount in USD')
    .option('--expiry <seconds>', 'Override expiry in seconds')
    .action(async (paymentRequired, opts, cmd) => {
      await signPaymentCommand({
        paymentRequired,
        amount: opts.amount,
        expiry: opts.expiry,
        outputMode: resolveOutputMode(cmd),
      });
    });

  // Show help if no subcommand
  if (args.length === 0) {
    program.outputHelp();
    return;
  }

  try {
    await program.parseAsync(['node', 'mcpc-x402', ...args]);
  } catch (error) {
    if (error instanceof ClientError) {
      console.error(formatError(error.message));
      process.exit(1);
    }
    throw error;
  }
}
