import { AsyncLocalStorage } from 'node:async_hooks';

import type { PaymentRequiredAccept, PaymentRequiredHeader } from './signer.js';

/** Exact payment proposal presented to a policy before any wallet signature exists. */
export interface X402PaymentPolicyContext {
  paymentRequired: PaymentRequiredHeader;
  selectedRequirements: PaymentRequiredAccept;
  /** Actual HTTP URL receiving the signature, when the transport exposes one. */
  requestUrl?: string;
}

export interface X402PaymentPolicyBlock {
  abort: true;
  reason: string;
}

/** Return nothing to allow, or an explicit block to abort before signing. */
export type X402PaymentPolicy = (
  context: X402PaymentPolicyContext
) => Promise<void | X402PaymentPolicyBlock>;

/**
 * Carries one policy-approved signature only through the async retry that owns it.
 * This prevents a concurrent tool call from consuming a signature approved for a
 * different resource or payee through the bridge's legacy process-wide cache.
 */
export class X402PaymentSignatureScope {
  private readonly storage = new AsyncLocalStorage<string>();

  get(): string | undefined {
    return this.storage.getStore();
  }

  run<T>(signature: string, retry: () => Promise<T>): Promise<T> {
    return this.storage.run(signature, retry);
  }
}
