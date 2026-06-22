/**
 * Unit tests for the OAuth client-credentials helpers
 * (src/lib/auth/client-credentials.ts).
 *
 * Covers the pure / local pieces — algorithm validation, private-key resolution,
 * and SDK provider selection. The full login + token-fetch flow (network) is
 * exercised by the e2e suite.
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { generateKeyPairSync } from 'crypto';
import { InvalidClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  validateKeyAlgorithm,
  resolvePrivateKeyPem,
  createClientCredentialsProvider,
  describeAuthError,
  DEFAULT_KEY_ALGORITHM,
} from '../../../../src/lib/auth/client-credentials.js';
import { ClientError } from '../../../../src/lib/errors.js';

describe('validateKeyAlgorithm', () => {
  it('accepts supported algorithms', () => {
    for (const alg of ['RS256', 'RS512', 'PS256', 'ES256', 'ES384', 'EdDSA']) {
      expect(() => validateKeyAlgorithm(alg)).not.toThrow();
    }
  });

  it('rejects unsupported algorithms with a ClientError', () => {
    expect(() => validateKeyAlgorithm('HS256')).toThrow(ClientError);
    expect(() => validateKeyAlgorithm('bogus')).toThrow(/Supported algorithms/);
  });

  it('defaults to RS256', () => {
    expect(DEFAULT_KEY_ALGORITHM).toBe('RS256');
    expect(() => validateKeyAlgorithm(DEFAULT_KEY_ALGORITHM)).not.toThrow();
  });
});

describe('resolvePrivateKeyPem', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpc-cc-key-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a literal PEM unchanged', async () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n';
    expect(await resolvePrivateKeyPem(pem)).toBe(pem);
  });

  it('reads a PEM from a file path', async () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nFROMFILE\n-----END PRIVATE KEY-----\n';
    const path = join(dir, 'key.pem');
    await writeFile(path, pem);
    expect(await resolvePrivateKeyPem(path)).toBe(pem);
  });

  it('throws a ClientError for a missing file', async () => {
    await expect(resolvePrivateKeyPem(join(dir, 'does-not-exist.pem'))).rejects.toThrow(
      ClientError
    );
  });
});

describe('createClientCredentialsProvider', () => {
  it('builds a ClientCredentialsProvider for the secret variant', () => {
    const provider = createClientCredentialsProvider({
      clientId: 'svc',
      clientSecret: 's3cr3t',
      scope: 'read',
    });
    expect(provider.constructor.name).toBe('ClientCredentialsProvider');
  });

  it('builds a PrivateKeyJwtProvider for the key variant', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const provider = createClientCredentialsProvider({
      clientId: 'svc',
      privateKeyPem: privateKey,
      keyAlg: 'RS256',
    });
    expect(provider.constructor.name).toBe('PrivateKeyJwtProvider');
  });

  it('throws when neither a secret nor a key is present', () => {
    expect(() => createClientCredentialsProvider({ clientId: 'svc' })).toThrow(ClientError);
  });

  it('pins the token endpoint via discoveryState when provided', async () => {
    const provider = createClientCredentialsProvider({
      clientId: 'svc',
      clientSecret: 's3cr3t',
      tokenEndpoint: 'https://auth.example.com/oauth/token',
    });
    expect(typeof provider.discoveryState).toBe('function');
    const state = await provider.discoveryState?.();
    expect(state?.authorizationServerUrl).toBe('https://auth.example.com');
    expect(state?.authorizationServerMetadata?.token_endpoint).toBe(
      'https://auth.example.com/oauth/token'
    );
  });

  it('leaves discoveryState undefined when no token endpoint is pinned', () => {
    const provider = createClientCredentialsProvider({ clientId: 'svc', clientSecret: 's3cr3t' });
    expect(provider.discoveryState).toBeUndefined();
  });
});

describe('describeAuthError', () => {
  it('falls back to the OAuth error code when the message is empty', () => {
    // A wrong client secret yields invalid_client with no error_description,
    // so the SDK leaves the message empty — we must surface the code instead.
    expect(describeAuthError(new InvalidClientError(''))).toBe('invalid_client');
  });

  it('prefers a non-empty error message over the code', () => {
    expect(describeAuthError(new InvalidClientError('client authentication failed'))).toBe(
      'client authentication failed'
    );
  });

  it('uses the error message for plain errors', () => {
    expect(describeAuthError(new Error('boom'))).toBe('boom');
  });

  it('falls back to the error name when message and code are absent', () => {
    const err = new Error('');
    err.name = 'WeirdError';
    expect(describeAuthError(err)).toBe('WeirdError');
  });

  it('stringifies non-Error values', () => {
    expect(describeAuthError('nope')).toBe('nope');
  });
});
