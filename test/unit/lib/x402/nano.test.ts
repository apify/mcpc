/**
 * Unit tests for Nano state block signing (x402 exact scheme on nano:mainnet)
 *
 * Vectors:
 * - Key/address: the `deterministic_key` example in the Nano RPC docs (seed 000...0, index 0).
 * - Block hash: the `block_hash` example in the Nano RPC docs.
 * - Signatures: computed independently with nanocurrency-js 2.5.0 (`createBlock`), since
 *   the docs' `sign` example does not use a matching key.
 */

import { ClientError } from '../../../../src/lib/errors.js';
import {
  createNanoSend,
  hashStateBlock,
  nanoAddressFromPublicKey,
  nanoPublicKeyFromPrivateKey,
  publicKeyFromNanoAddress,
  signNanoBlockHash,
} from '../../../../src/lib/x402/nano.js';

const hex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex').toUpperCase();

const PRIVATE_KEY = '9F0E444C69F77A49BD0BE89DB92C38FE713E0963165CCA12FAF5712D7657120F';
const PUBLIC_KEY = 'C008B814A7D269A1FA3C6528B19201A24D797912DB9996FF02A1FF356E45552B';
const ACCOUNT = 'nano_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7';

const REPRESENTATIVE = 'nano_1stofnrxuz3cai7ze75o174bpm7scwj9jn3nxsn8ntzg784jf1gzn1jjdkou';
const PAY_TO = 'nano_1x7biz69cem95oo7gxkrw6kzhfywq4x5dupw4z1bdzkb74dk9kpxwzjbdhhs';
const PAY_TO_PUBLIC_KEY = '74A987C87532671D6A577658E125F7B7DCB8BA35EEDC17C095FE49289723CADD';

/** A state block signed by ACCOUNT: the frontier the fake RPC reports. */
const FRONTIER = '1887C9C3E9006E1EF83B5FDEE0C6095C7424172926077B0DDFD74FF37F92AEBD';
const FRONTIER_CONTENTS = {
  type: 'state',
  account: ACCOUNT,
  previous: '991CF190094C00F0B68E2E5F75F6BEE95A2E0BD93CEAA4A6734DB9F19B728948',
  representative: REPRESENTATIVE,
  balance: '1000000000000000000000000000000',
  link: PAY_TO_PUBLIC_KEY,
  link_as_account: PAY_TO,
  signature:
    '2DC99833D0C80A72314C5605CBB69037DB63EFE9FFA8DB86E928562D7328262339AEB5682CCC8339F00A01284AF00A42F67ADF7BB31ED44BE1A26F9D99F6CA0D',
  work: '0000000000000000',
};

describe('Nano addresses', () => {
  it('derives the documented public key and address from a private key', () => {
    const publicKey = nanoPublicKeyFromPrivateKey(hex(PRIVATE_KEY));
    expect(toHex(publicKey)).toBe(PUBLIC_KEY);
    expect(nanoAddressFromPublicKey(publicKey)).toBe(ACCOUNT);
  });

  it('decodes nano_ and xrb_ addresses', () => {
    expect(toHex(publicKeyFromNanoAddress(ACCOUNT))).toBe(PUBLIC_KEY);
    expect(toHex(publicKeyFromNanoAddress(ACCOUNT.replace('nano_', 'xrb_')))).toBe(PUBLIC_KEY);
  });

  it('rejects a bad checksum or malformed address', () => {
    expect(() => publicKeyFromNanoAddress(ACCOUNT.slice(0, -1) + '8')).toThrow('bad checksum');
    expect(() => publicKeyFromNanoAddress('nano_abc')).toThrow(ClientError);
    expect(() => publicKeyFromNanoAddress('0xdf278412ecbe00d6381408f739eb8da60542a0c4')).toThrow(
      'Invalid Nano address'
    );
  });
});

describe('Nano state blocks', () => {
  it('hashes the documented block_hash example', () => {
    const hash = hashStateBlock({
      account: publicKeyFromNanoAddress(
        'nano_3qgmh14nwztqw4wmcdzy4xpqeejey68chx6nciczwn9abji7ihhum9qtpmdr'
      ),
      previous: hex('F47B23107E5F34B2CE06F562B5C435DF72A533251CB414C51B2B62A8F63A00E4'),
      representative: publicKeyFromNanoAddress(
        'nano_1hza3f7wiiqa7ig3jczyxj5yo86yegcmqk3criaz838j91sxcckpfhbhhra1'
      ),
      balance: 1000000000000000000000n,
      link: hex('19D3D919475DEED4696B5D13018151D1AF88B2BD3BCFF048B45031C1F36D1858'),
    });
    expect(toHex(hash)).toBe('FF0144381CFF0B2C079A115E7ADA7E96F43FD219446E7524C48D1CC9900C4F17');
  });

  it('hashes and signs a block like nanocurrency-js', () => {
    const hash = hashStateBlock({
      account: hex(PUBLIC_KEY),
      previous: hex(FRONTIER_CONTENTS.previous),
      representative: publicKeyFromNanoAddress(REPRESENTATIVE),
      balance: BigInt(FRONTIER_CONTENTS.balance),
      link: hex(PAY_TO_PUBLIC_KEY),
    });
    expect(toHex(hash)).toBe(FRONTIER);
    expect(toHex(signNanoBlockHash(hash, hex(PRIVATE_KEY)))).toBe(FRONTIER_CONTENTS.signature);
  });
});

describe('createNanoSend', () => {
  let requests: Record<string, string>[];
  let contents: Record<string, string>;

  beforeEach(() => {
    requests = [];
    contents = { ...FRONTIER_CONTENTS };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as Record<string, string>;
        requests.push(request);
        const replies: Record<string, unknown> = {
          account_info: { frontier: FRONTIER, balance: contents.balance },
          block_info: { contents, subtype: 'send' },
          work_generate: { work: '2BF29EF00786A6BC' },
        };
        return new Response(JSON.stringify(replies[request.action!] ?? { error: 'bad action' }));
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const send = (amountRaw: bigint) =>
    createNanoSend({
      privateKey: hex(PRIVATE_KEY),
      payTo: PAY_TO,
      amountRaw,
      rpcUrl: 'http://127.0.0.1:7076',
    });

  it('builds and signs a send block on top of the verified frontier', async () => {
    const { block, hash } = await send(1000n);

    // Expected hash and signature computed with nanocurrency-js for the same block
    expect(hash).toBe('EED728A7F2611AF5C832A9946B5384FA2D7FE51A67821E162DCE56CFCE534D05');
    expect(block).toEqual({
      type: 'state',
      account: ACCOUNT,
      previous: FRONTIER,
      representative: REPRESENTATIVE,
      balance: '999999999999999999999999999000',
      link: PAY_TO_PUBLIC_KEY,
      link_as_account: PAY_TO,
      signature:
        'D731474AC9BE353FD2B38E296E59355BB66444343D9A29529A2DD33D6DBB02092DDA70E5CCE6A5CAB882042D9EE4F326F35CF42ACEEA5E073648CD80587A7705',
      work: '2bf29ef00786a6bc',
    });
    expect(requests.map((r) => r.action)).toEqual(['account_info', 'block_info', 'work_generate']);
    expect(requests[2]?.hash).toBe(FRONTIER);
    // Signed only: nothing is published
    expect(requests.some((r) => r.action === 'process')).toBe(false);
  });

  it('refuses when the RPC misreports the frontier balance', async () => {
    // A lower balance would make the block send more than asked
    contents.balance = '1000000000000000000000000';
    await expect(send(1000n)).rejects.toThrow('not signed by this account');
  });

  it('refuses when the balance is insufficient', async () => {
    await expect(send(BigInt(FRONTIER_CONTENTS.balance) + 1n)).rejects.toThrow(
      'Insufficient Nano balance'
    );
  });

  it('rejects a zero amount and a bad payTo before calling the RPC', async () => {
    await expect(send(0n)).rejects.toThrow('must be positive');
    await expect(
      createNanoSend({
        privateKey: hex(PRIVATE_KEY),
        payTo: PAY_TO.slice(0, -1) + '8',
        amountRaw: 1n,
        rpcUrl: 'http://127.0.0.1:7076',
      })
    ).rejects.toThrow('bad checksum');
    expect(requests).toEqual([]);
  });

  it('surfaces RPC errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Account not found' })))
    );
    await expect(send(1n)).rejects.toThrow('Nano RPC account_info failed: Account not found');
  });
});
